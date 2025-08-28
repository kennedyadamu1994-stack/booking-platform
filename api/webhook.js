// api/webhook.js - Complete solution: Save booking AFTER payment with event details
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
            eventId: metadata.eventId,
            eventName: metadata.eventName,
            customerName: metadata.customerName,
            customerEmail: metadata.customerEmail,
            skillLevel: metadata.skillLevel,
            addons: metadata.addons === 'None' ? '' : metadata.addons,
            amount: parseFloat(metadata.amount),
            paymentIntentId: paymentIntentId
        };

        console.log('Booking data from Stripe metadata:', bookingData);

        // NOW save the booking to Google Sheets with event details
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

// Complete function that saves booking AFTER payment with event details
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
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    // STEP 1: Get event details from Events sheet
    console.log('Fetching event details from Events sheet...');
    const eventsResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'Events!A:R', // Full range to get all event data
    });

    const eventRows = eventsResponse.data.values;
    if (!eventRows || eventRows.length === 0) {
        throw new Error('No data found in Events sheet');
    }

    // Find the event by event_id (column A)
    let eventDetails = null;
    for (let i = 1; i < eventRows.length; i++) {
        if (eventRows[i][0] === bookingData.eventId) {
            eventDetails = {
                id: eventRows[i][0],          // A: event_id
                name: eventRows[i][1],        // B: event_name
                description: eventRows[i][2], // C: description
                date: eventRows[i][3],        // D: date
                time: eventRows[i][4],        // E: time
                location: eventRows[i][5],    // F: location
                totalSpots: eventRows[i][8],  // I: total_spots
                spotsRemaining: eventRows[i][9] // J: spots_remaining
            };
            break;
        }
    }

    if (!eventDetails) {
        throw new Error(`Event not found: ${bookingData.eventId}`);
    }

    console.log('Event details found:', eventDetails);

    // STEP 2: Create complete booking row with event details
    const bookingId = `BK${Date.now()}`;
    const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    // Build comprehensive booking row (A through N)
    const bookingRow = [
        bookingId,                          // A: booking_id
        currentDate,                        // B: booking_date
        bookingData.eventId,                // C: event_id
        bookingData.eventName,              // D: event_name
        bookingData.customerName,           // E: customer_name
        bookingData.customerEmail,          // F: customer_email
        Number(bookingData.amount.toFixed(2)), // G: amount_paid
        bookingData.addons || '',           // H: addons_selected
        bookingData.paymentIntentId,        // I: stripe_payment_id
        'Confirmed',                        // J: status - CONFIRMED after payment!
        '',                                 // K: email_sent
        '',                                 // L: email_sent_to_instructor (if exists)
        bookingData.skillLevel || '',       // M: skill_level
        eventDetails.date || '',            // N: event_date
        eventDetails.time || '',            // O: event_time  
        eventDetails.location || ''         // P: event_location
    ];

    console.log('Complete booking row to save:', bookingRow);

    // STEP 3: Save to Bookings sheet (extend range to include event details)
    const appendRequest = {
        spreadsheetId: spreadsheetId,
        range: 'Bookings!A:P', // Extended range to include event details
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
            values: [bookingRow]
        }
    };
    
    console.log('Saving booking to Google Sheets...');
    await sheets.spreadsheets.values.append(appendRequest);
    
    console.log('✅ Booking saved with status "Confirmed" - will trigger email system');

    // STEP 4: Reduce event spots
    const newSpots = Math.max(0, (parseInt(eventDetails.spotsRemaining) || 0) - 1);
    
    // Find the event row index again to update spots
    let eventRowIndex = -1;
    for (let i = 1; i < eventRows.length; i++) {
        if (eventRows[i][0] === bookingData.eventId) {
            eventRowIndex = i + 1; // 1-based index
            break;
        }
    }

    if (eventRowIndex > 0) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: spreadsheetId,
            range: `Events!J${eventRowIndex}`, // Column J = spots_remaining
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[newSpots]]
            }
        });
        
        console.log(`✅ Reduced event spots to ${newSpots}`);
    }
    
    console.log('✅ Complete booking process finished');
    
    return { eventId: bookingData.eventId };
}
