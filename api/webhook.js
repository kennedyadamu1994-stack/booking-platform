// api/webhook.js - Handle post-payment updates (Fixed ID matching)
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

        // Update the booking status in Google Sheets (try both session ID and payment intent ID)
        await updateBookingStatus(sessionId, paymentIntentId, 'completed');

        res.status(200).json({ 
            success: true, 
            message: 'Booking updated successfully',
            sessionId: sessionId,
            paymentIntentId: paymentIntentId 
        });

    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ 
            error: 'Failed to process webhook', 
            details: error.message 
        });
    }
};

// Function to update booking status in Google Sheets (improved matching)
async function updateBookingStatus(sessionId, paymentIntentId, newStatus) {
    console.log('Updating booking status...');
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

    // Read all booking data from A:N (includes skill level in column M)
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'Bookings!A:N',
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
        throw new Error('No data found in Bookings sheet');
    }

    console.log(`Found ${rows.length - 1} booking rows to search`);

    // Find the row with matching payment ID (try both session ID and payment intent ID)
    const headers = rows[0];
    const stripePaymentIdIndex = headers.indexOf('stripe_payment_id');
    const statusIndex = headers.indexOf('status');
    
    if (stripePaymentIdIndex === -1 || statusIndex === -1) {
        throw new Error('Required columns not found in sheet');
    }

    console.log('Looking for booking with stripe_payment_id in column:', stripePaymentIdIndex);

    // Find the matching row - try both session ID and payment intent ID
    let rowIndex = -1;
    let matchedId = null;
    
    for (let i = 1; i < rows.length; i++) {
        const rowStripeId = rows[i][stripePaymentIdIndex];
        console.log(`Row ${i}: stripe_payment_id = "${rowStripeId}"`);
        
        if (rowStripeId === sessionId || rowStripeId === paymentIntentId) {
            rowIndex = i + 1; // Convert to 1-based index for Sheets API
            matchedId = rowStripeId;
            console.log(`✅ Found match at row ${rowIndex} with ID: ${matchedId}`);
            break;
        }
    }

    if (rowIndex === -1) {
        console.error('❌ No booking found with either ID');
        console.error('Searched for session ID:', sessionId);
        console.error('Searched for payment intent ID:', paymentIntentId);
        console.error('Available stripe_payment_ids in sheet:');
        for (let i = 1; i < rows.length; i++) {
            console.error(`  Row ${i}: "${rows[i][stripePaymentIdIndex]}"`);
        }
        throw new Error(`Booking not found for session ID: ${sessionId} or payment intent: ${paymentIntentId}`);
    }

    console.log(`Updating booking status to "${newStatus}" for row ${rowIndex}`);

    // Update the status column (J)
    const statusColumnLetter = 'J';
    const updateRange = `Bookings!${statusColumnLetter}${rowIndex}`;
    
    await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: updateRange,
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [[newStatus]]
        }
    });

    console.log('✅ Successfully updated booking status');
    
    // Log the skill level from column M for verification
    if (rows[rowIndex - 1] && rows[rowIndex - 1][12]) {
        console.log('✅ Confirmed skill level in column M:', rows[rowIndex - 1][12]);
    } else {
        console.log('⚠️ No skill level found in column M');
    }
    
    console.log('Booking update completed successfully');
}
