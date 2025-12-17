// api/create-direct-booking.js - Direct booking without Stripe payment
// Used for free sessions or interest registration
module.exports = async (req, res) => {
    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        console.log('🎯 Starting DIRECT booking process (no payment)...');
        console.log('📨 Request payload:', JSON.stringify(req.body, null, 2));
        
        // Get booking details from the form
        const { 
            eventId, 
            eventName, 
            customerName, 
            customerEmail, 
            skillLevel,
            amount, 
            addons
        } = req.body;
        
        // Validate required fields
        if (!eventId || !eventName || !customerName || !customerEmail || !skillLevel) {
            console.error('❌ Missing required fields');
            return res.status(400).json({ 
                error: 'Missing required fields',
                required: ['eventId', 'eventName', 'customerName', 'customerEmail', 'skillLevel']
            });
        }
        
        console.log('✅ All required fields present');
        console.log('📝 Skill level:', skillLevel);
        
        // Generate booking ID
        const bookingId = `BK${Date.now()}`;
        console.log('🎫 Generated booking ID:', bookingId);
        
        // Save booking directly to Google Sheets
        const result = await saveDirectBookingToSheets({
            bookingId,
            eventId,
            eventName,
            customerName,
            customerEmail,
            skillLevel,
            amount: amount || 0,
            addons: addons || []
        });
        
        console.log('✅ Direct booking saved successfully');
        
        // Return success with booking ID (redirects to success page)
        const successUrl = `${process.env.SITE_URL}/success.html?booking_id=${bookingId}`;
        console.log('🎯 Redirecting to:', successUrl);
        
        res.status(200).json({ 
            success: true,
            bookingId: bookingId,
            redirectUrl: successUrl
        });
        
    } catch (error) {
        console.error('❌ Direct booking error:', error);
        res.status(500).json({ 
            error: 'Unable to process booking', 
            details: error.message 
        });
    }
};

// Function to save direct booking to Google Sheets
async function saveDirectBookingToSheets(bookingData) {
    console.log('💾 Saving direct booking to Google Sheets...');
    
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
    console.log('📋 Fetching event details from Events sheet...');
    const eventsResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'Events!A:AF', // Include all columns up to booking_type (Column AE)
    });

    const eventRows = eventsResponse.data.values;
    if (!eventRows || eventRows.length === 0) {
        throw new Error('No data found in Events sheet');
    }

    // Find the event by event_id
    let eventDetails = null;
    let eventRowIndex = -1;
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
            eventRowIndex = i + 1; // 1-based index for sheets
            break;
        }
    }

    if (!eventDetails) {
        throw new Error(`Event not found: ${bookingData.eventId}`);
    }

    console.log('✅ Event details found:', eventDetails);

    // STEP 2: Check if spots are available
    const spotsRemaining = parseInt(eventDetails.spotsRemaining) || 0;
    if (spotsRemaining <= 0) {
        throw new Error('No spots remaining for this event');
    }

    // STEP 3: Create booking row
    const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    const bookingRow = [
        bookingData.bookingId,              // A: booking_id
        currentDate,                        // B: booking_date
        bookingData.eventId,                // C: event_id
        bookingData.eventName,              // D: event_name
        bookingData.customerName,           // E: customer_name
        bookingData.customerEmail,          // F: customer_email
        Number(bookingData.amount.toFixed(2)), // G: amount_paid (0 for free)
        bookingData.addons.join(', ') || '', // H: addons_selected
        'DIRECT_BOOKING',                   // I: stripe_payment_id (marker for direct bookings)
        'Confirmed',                        // J: status - CONFIRMED immediately!
        '',                                 // K: email_sent
        '',                                 // L: email_sent_to_instructor
        bookingData.skillLevel || '',       // M: skill_level
        eventDetails.date || '',            // N: event_date
        eventDetails.time || '',            // O: event_time  
        eventDetails.location || ''         // P: event_location
    ];

    console.log('📝 Booking row to save:', bookingRow);

    // STEP 4: Save to Bookings sheet
    const appendRequest = {
        spreadsheetId: spreadsheetId,
        range: 'Bookings!A:P',
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
            values: [bookingRow]
        }
    };
    
    console.log('💾 Saving to Google Sheets...');
    await sheets.spreadsheets.values.append(appendRequest);
    
    console.log('✅ Booking saved with status "Confirmed"');

    // STEP 5: Reduce event spots
    const newSpots = Math.max(0, spotsRemaining - 1);
    
    await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: `Events!J${eventRowIndex}`, // Column J = spots_remaining
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [[newSpots]]
        }
    });
    
    console.log(`✅ Reduced event spots to ${newSpots}`);
    
    console.log('✅ Complete direct booking process finished');
    
    return { 
        bookingId: bookingData.bookingId,
        eventId: bookingData.eventId 
    };
}
