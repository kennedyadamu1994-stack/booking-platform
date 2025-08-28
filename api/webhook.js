// api/webhook.js - Fixed to update status to "Confirmed" after payment
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

        // Get payment intent from Stripe checkout session
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        let paymentIntentId = sessionId;
        
        if (sessionId.startsWith('cs_test_') || sessionId.startsWith('cs_live_')) {
            console.log('Converting checkout session to payment intent...');
            
            try {
                const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
                paymentIntentId = checkoutSession.payment_intent;
                console.log('Payment intent ID:', paymentIntentId);
            } catch (stripeError) {
                console.error('Error retrieving checkout session:', stripeError);
                return res.status(500).json({ error: 'Failed to retrieve session from Stripe' });
            }
        }

        // Update the booking status to "Confirmed" and reduce event spots
        const { eventId } = await updateBookingAndSpots(sessionId, paymentIntentId);

        res.status(200).json({ 
            success: true, 
            message: 'Booking confirmed successfully and spots reduced',
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

// Updated function that handles both booking confirmation AND spots reduction
async function updateBookingAndSpots(sessionId, paymentIntentId) {
    console.log('Updating booking to Confirmed and reducing event spots...');
    console.log('Session ID:', sessionId);
    console.log('Payment Intent ID:', paymentIntentId);
    
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

    // Read all booking data from A:N
    const bookingResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'Bookings!A:N',
    });

    const bookingRows = bookingResponse.data.values;
    if (!bookingRows || bookingRows.length === 0) {
        throw new Error('No data found in Bookings sheet');
    }

    console.log(`Found ${bookingRows.length - 1} booking rows to search`);

    // Find the matching booking row
    const headers = bookingRows[0];
    const stripePaymentIdIndex = headers.indexOf('stripe_payment_id');
    const statusIndex = headers.indexOf('status');
    const eventIdIndex = headers.indexOf('event_id');
    
    if (stripePaymentIdIndex === -1 || statusIndex === -1 || eventIdIndex === -1) {
        throw new Error('Required columns not found in Bookings sheet');
    }

    let rowIndex = -1;
    let eventId = null;
    
    for (let i = 1; i < bookingRows.length; i++) {
        const rowStripeId = bookingRows[i][stripePaymentIdIndex];
        
        if (rowStripeId === sessionId || rowStripeId === paymentIntentId) {
            rowIndex = i + 1; // Convert to 1-based index for Sheets API
            eventId = bookingRows[i][eventIdIndex];
            console.log(`✅ Found booking at row ${rowIndex} for event: ${eventId}`);
            break;
        }
    }

    if (rowIndex === -1) {
        throw new Error(`Booking not found for session ID: ${sessionId} or payment intent: ${paymentIntentId}`);
    }

    // CRITICAL FIX: Update status to "Confirmed" so email system can detect it
    console.log('Setting booking status to "Confirmed" - this will trigger the email system');
    
    await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: `Bookings!${getColumnLetter(statusIndex + 1)}${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [['Confirmed']]
        }
    });

    console.log('✅ Booking status updated to "Confirmed"');
    
    // Now reduce the event spots
    await reduceEventSpots(sheets, spreadsheetId, eventId);

    console.log('✅ Booking confirmed and event spots updated');
    
    return { eventId };
}

// Function to reduce event spots
async function reduceEventSpots(sheets, spreadsheetId, eventId) {
    console.log(`Reducing spots for event: ${eventId}`);
    
    // Read Events sheet
    const eventsResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'Events!A:J',
    });

    const eventRows = eventsResponse.data.values;
    if (!eventRows || eventRows.length === 0) {
        throw new Error('No data found in Events sheet');
    }

    // Find the event row (assuming event_id is in column A, spots_remaining is in column J)
    let eventRowIndex = -1;
    
    for (let i = 1; i < eventRows.length; i++) {
        if (eventRows[i][0] === eventId) {
            eventRowIndex = i + 1; // Convert to 1-based index
            break;
        }
    }

    if (eventRowIndex === -1) {
        throw new Error(`Event not found: ${eventId}`);
    }

    // Get current spots remaining (column J = index 9)
    const currentSpots = eventRows[eventRowIndex - 1][9]; // Back to 0-based for array
    const newSpots = Math.max(0, (parseInt(currentSpots) || 0) - 1);
    
    console.log(`Event ${eventId}: ${currentSpots} spots → ${newSpots} spots`);

    // Update spots remaining in column J
    await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: `Events!J${eventRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [[newSpots]]
        }
    });

    console.log(`✅ Successfully reduced spots for event ${eventId} to ${newSpots}`);
}

// Helper function to convert column number to letter (A, B, C, etc.)
function getColumnLetter(columnNumber) {
    let columnLetter = '';
    while (columnNumber > 0) {
        columnNumber--;
        columnLetter = String.fromCharCode(65 + (columnNumber % 26)) + columnLetter;
        columnNumber = Math.floor(columnNumber / 26);
    }
    return columnLetter;
}
