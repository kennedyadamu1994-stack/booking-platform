// Updated api/webhook.js - Works with NBRH IDs and Sessions sheet
module.exports = async (req, res) => {
    console.log('Webhook called with method:', req.method);
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { sessionId, type } = req.body;
        
        console.log('Processing webhook:', { sessionId, type });

        if (!sessionId) {
            return res.status(400).json({ error: 'Session ID required' });
        }

        // Get payment details and booking data from Stripe
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        let paymentIntentId = sessionId;
        let checkoutSession = null;
        
        if (sessionId.startsWith('cs_test_') || sessionId.startsWith('cs_live_')) {
            console.log('Retrieving checkout session and payment intent...');
            
            try {
                checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
                    expand: ['payment_intent']
                });
                paymentIntentId = checkoutSession.payment_intent.id;
                console.log('Payment intent ID:', paymentIntentId);
            } catch (stripeError) {
                console.error('Error retrieving checkout session:', stripeError);
                return res.status(500).json({ error: 'Failed to retrieve session from Stripe' });
            }
        }

        // Extract booking data from Stripe metadata
        const metadata = checkoutSession.metadata;
        const bookingData = {
            eventId: metadata.eventId, // This is the NBRH ID
            eventName: metadata.eventName,
            customerName: metadata.customerName,
            customerEmail: metadata.customerEmail,
            skillLevel: metadata.skillLevel,
            addons: metadata.addons === 'None' ? '' : metadata.addons,
            amount: parseFloat(metadata.amount),
            paymentIntentId: paymentIntentId
        };

        console.log('Booking data from Stripe metadata:', bookingData);

        // Save the booking to Google Sheets
        const { eventId } = await saveCompleteBookingAfterPayment(bookingData);

        res.status(200).json({ 
            success: true, 
            message: 'Booking saved successfully after payment confirmation',
            sessionId: sessionId,
            paymentIntentId: paymentIntentId,
            eventId: eventId
        });

    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ 
            error: 'Failed to process webhook', 
            details: error.message 
        });
    }
};

// Complete function that saves booking AFTER payment
async function saveCompleteBookingAfterPayment(bookingData) {
    console.log('Saving complete booking after successful payment...');
    
    // Import googleapis
    const { google } = require('googleapis');
    
    // Parse credentials
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    
    // Create auth and sheets client
    const auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    const sessionsSheetId = process.env.SESSIONS_SHEET_ID;
    const bookingsSheetId = process.env.BOOKINGS_SHEET_ID;

    // STEP 1: Get session details from Sessions sheet using NBRH ID
    console.log('Fetching session details from Sessions sheet...');
    const sessionsResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: sessionsSheetId, // Read from Sessions sheet
        range: 'Sessions!A:AV', // All columns including Session ID and Booking Type
    });

    const sessionRows = sessionsResponse.data.values;
    if (!sessionRows || sessionRows.length === 0) {
        throw new Error('No data found in Sessions sheet');
    }

    // Find the session by NBRH ID (column A)
    let sessionDetails = null;
    let sessionRowIndex = -1;
    
    for (let i = 1; i < sessionRows.length; i++) {
        if (sessionRows[i][0] === bookingData.eventId) { // Column A = NBRH ID
            sessionDetails = {
                nbrhId: sessionRows[i][0],        // A: NBRH ID
                activityType: sessionRows[i][1],  // B: Activity Type
                club: sessionRows[i][2],          // C: CLUB
                className: sessionRows[i][3],     // D: Class Name
                date: sessionRows[i][4],          // E: Date
                startTime: sessionRows[i][5],     // F: Start Time
                duration: sessionRows[i][6],      // G: Duration
                address: sessionRows[i][7],       // H: Address
                location: sessionRows[i][8],      // I: Location
                basePrice: sessionRows[i][9],     // J: Base Price
                totalPrice: sessionRows[i][11],   // L: Total Price
                spotsAvailable: sessionRows[i][12], // M: Spots Available
                totalSpots: sessionRows[i][13]    // N: Total Spots
            };
            sessionRowIndex = i + 1; // 1-based index
            break;
        }
    }

    if (!sessionDetails) {
        throw new Error(`Session not found with NBRH ID: ${bookingData.eventId}`);
    }

    console.log('Session details found:', sessionDetails);

    // STEP 2: Create complete booking row
    const bookingId = `BK${Date.now()}`;
    const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    // Build comprehensive booking row
    const bookingRow = [
        bookingId,                          // A: booking_id
        currentDate,                        // B: booking_date
        bookingData.eventId,                // C: event_id (NBRH ID)
        bookingData.eventName,              // D: event_name
        bookingData.customerName,           // E: customer_name
        bookingData.customerEmail,          // F: customer_email
        Number(bookingData.amount.toFixed(2)), // G: amount_paid
        bookingData.addons || '',           // H: addons_selected
        bookingData.paymentIntentId,        // I: stripe_payment_id
        'Confirmed',                        // J: status - CONFIRMED after payment!
        '',                                 // K: email_sent
        '',                                 // L: email_sent_to_instructor
        bookingData.skillLevel || '',       // M: skill_level
        sessionDetails.date || '',          // N: event_date
        sessionDetails.startTime || '',     // O: event_time  
        sessionDetails.location || ''       // P: event_location
    ];

    console.log('Complete booking row to save:', bookingRow);

    // STEP 3: Save to Bookings sheet (in separate spreadsheet)
    const appendRequest = {
        spreadsheetId: bookingsSheetId, // Save to Bookings spreadsheet
        range: 'Bookings!A:P', // Save to Bookings tab
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
            values: [bookingRow]
        }
    };
    
    console.log('Saving booking to Bookings sheet...');
    await sheets.spreadsheets.values.append(appendRequest);
    
    console.log('✅ Booking saved to Bookings sheet with status "Confirmed"');

    // STEP 4: Reduce session spots in Sessions sheet
    const currentSpots = parseInt(sessionDetails.spotsAvailable) || 0;
    const newSpots = Math.max(0, currentSpots - 1);
    
    console.log(`📉 Reducing spots from ${currentSpots} to ${newSpots}...`);
    console.log(`📍 Updating row ${sessionRowIndex} in Sessions sheet`);
    console.log(`📍 Sheet ID: ${sessionsSheetId}`);
    
    if (sessionRowIndex > 0) {
        try {
            const updateResponse = await sheets.spreadsheets.values.update({
                spreadsheetId: sessionsSheetId, // Update Sessions sheet (different spreadsheet)
                range: `Sessions!M${sessionRowIndex}`, // Column M = spots_available
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [[newSpots]]
                }
            });
            
            console.log(`✅ Reduced session spots from ${currentSpots} to ${newSpots}`);
            console.log(`✅ Update response:`, JSON.stringify(updateResponse.data));
        } catch (updateError) {
            console.error('❌ Failed to update spots in Sessions sheet:', updateError);
            console.error('❌ Error details:', JSON.stringify(updateError));
            console.error('❌ Attempted to update:', `Sessions!M${sessionRowIndex}`, 'in sheet:', sessionsSheetId);
            // Don't throw here - booking is already saved
            console.log('⚠️ Booking saved successfully but spots not updated in Sessions sheet');
        }
    }
    
    console.log('✅ Complete booking process finished');
    
    return { eventId: bookingData.eventId };
}
