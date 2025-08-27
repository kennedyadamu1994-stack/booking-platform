// /api/webhook.js - Handle post-payment updates
export default async function handler(req, res) {
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

        // Update the booking status in Google Sheets
        await updateBookingStatus(paymentIntentId, 'completed');

        res.status(200).json({ 
            success: true, 
            message: 'Booking updated successfully',
            paymentIntentId: paymentIntentId 
        });

    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ 
            error: 'Failed to process webhook', 
            details: error.message 
        });
    }
}

// Function to update booking status in Google Sheets
async function updateBookingStatus(paymentIntentId, newStatus) {
    console.log('Updating booking status for payment intent:', paymentIntentId);
    
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
        range: 'Bookings!A:N', // Use A:N range to include skill level column
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
        throw new Error('No data found in Bookings sheet');
    }

    // Find the row with matching payment intent
    const headers = rows[0];
    const stripePaymentIdIndex = headers.indexOf('stripe_payment_id');
    const statusIndex = headers.indexOf('status');
    
    if (stripePaymentIdIndex === -1 || statusIndex === -1) {
        throw new Error('Required columns not found in sheet');
    }

    // Find the matching row
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
        if (rows[i][stripePaymentIdIndex] === paymentIntentId) {
            rowIndex = i + 1; // Convert to 1-based index for Sheets API
            break;
        }
    }

    if (rowIndex === -1) {
        throw new Error(`Booking not found for payment intent: ${paymentIntentId}`);
    }

    console.log(`Found booking at row ${rowIndex}, updating status to: ${newStatus}`);

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

    console.log('Successfully updated booking status');
    
    // Log the skill level from column M for verification
    if (rows[rowIndex - 1] && rows[rowIndex - 1][12]) {
        console.log('Confirmed skill level in column M:', rows[rowIndex - 1][12]);
    }
}
