// This file handles updates to Google Sheets after successful payments
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Handle different types of webhooks
        if (req.headers['stripe-signature']) {
            // This is from Stripe
            const sig = req.headers['stripe-signature'];
            let event;
            
            try {
                event = stripe.webhooks.constructEvent(
                    req.body,
                    sig,
                    process.env.STRIPE_WEBHOOK_SECRET
                );
            } catch (err) {
                console.error('Webhook signature verification failed:', err);
                return res.status(400).send(`Webhook Error: ${err.message}`);
            }
            
            // Handle successful payment
            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                
                // Prepare booking data
                const bookingData = {
                    booking_id: session.id.substring(0, 8).toUpperCase(),
                    booking_date: new Date().toISOString().split('T')[0],
                    event_id: session.metadata.eventId,
                    event_name: session.metadata.eventName,
                    customer_name: session.metadata.customerName,
                    customer_email: session.customer_email,
                    amount_paid: session.amount_total / 100,
                    addons_selected: session.metadata.addons || 'None',
                    stripe_payment_id: session.payment_intent,
                    status: 'Confirmed'
                };
                
                // Update Google Sheets
                await updateGoogleSheets(bookingData);
                
                // Send confirmation email (optional - requires email service setup)
                // await sendConfirmationEmail(bookingData);
            }
        } else {
            // This is from our success page
            const { sessionId, type } = req.body;
            
            if (type === 'booking.confirmed') {
                // Retrieve session from Stripe
                const session = await stripe.checkout.sessions.retrieve(sessionId);
                
                // Update sheets with session data
                const bookingData = {
                    booking_id: session.id.substring(0, 8).toUpperCase(),
                    booking_date: new Date().toISOString().split('T')[0],
                    event_id: session.metadata.eventId,
                    event_name: session.metadata.eventName,
                    customer_name: session.metadata.customerName,
                    customer_email: session.customer_email,
                    amount_paid: session.amount_total / 100,
                    addons_selected: session.metadata.addons || 'None',
                    stripe_payment_id: session.payment_intent,
                    status: 'Confirmed'
                };
                
                await updateGoogleSheets(bookingData);
            }
        }
        
        res.json({ received: true });
        
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
}

async function updateGoogleSheets(bookingData) {
    const SHEET_ID = process.env.GOOGLE_SHEET_ID;
    const API_KEY = process.env.GOOGLE_API_KEY;
    
    try {
        // Append to Bookings sheet
        const range = 'Bookings!A:J';
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&key=${API_KEY}`;
        
        const values = [[
            bookingData.booking_id,
            bookingData.booking_date,
            bookingData.event_id,
            bookingData.event_name,
            bookingData.customer_name,
            bookingData.customer_email,
            bookingData.amount_paid,
            bookingData.addons_selected,
            bookingData.stripe_payment_id,
            bookingData.status
        ]];
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ values })
        });
        
        if (!response.ok) {
            throw new Error('Failed to update Google Sheets');
        }
        
        // Also update spots remaining in Events sheet
        await updateSpotsRemaining(bookingData.event_id);
        
    } catch (error) {
        console.error('Google Sheets update failed:', error);
        // Don't throw - we don't want to fail the webhook
    }
}

async function updateSpotsRemaining(eventId) {
    // This would update the spots_remaining column
    // Implementation depends on your specific needs
    console.log(`Updating spots for event: ${eventId}`);
}
