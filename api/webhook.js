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

async function getAccessToken() {
    try {
        // Get service account from environment variable
        const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
        
        // Create JWT
        const jwt = require('jsonwebtoken');
        const now = Math.floor(Date.now() / 1000);
        
        const payload = {
            iss: serviceAccount.client_email,
            scope: 'https://www.googleapis.com/auth/spreadsheets',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now
        };
        
        const token = jwt.sign(payload, serviceAccount.private_key, { algorithm: 'RS256' });
        
        // Exchange JWT for access token
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`
        });
        
        const data = await response.json();
        return data.access_token;
        
    } catch (error) {
        console.error('Failed to get access token:', error);
        throw error;
    }
}

async function updateGoogleSheets(bookingData) {
    const SHEET_ID = process.env.GOOGLE_SHEET_ID;
    
    try {
        // Get access token using service account
        const accessToken = await getAccessToken();
        
        // Append to Bookings sheet
        const range = 'Bookings!A:J';
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`;
        
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
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({ values })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Google Sheets API error:', errorText);
            throw new Error('Failed to update Google Sheets');
        }
        
        console.log('Successfully updated Google Sheets');
        
        // Also update spots remaining in Events sheet
        await updateSpotsRemaining(bookingData.event_id, accessToken);
        
    } catch (error) {
        console.error('Google Sheets update failed:', error);
        // Don't throw - we don't want to fail the webhook
    }
}

async function updateSpotsRemaining(eventId, accessToken) {
    try {
        const SHEET_ID = process.env.GOOGLE_SHEET_ID;
        
        // First, get current data to find the row
        const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Events!A:J`;
        
        const getResponse = await fetch(getUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        
        if (!getResponse.ok) {
            throw new Error('Failed to get current event data');
        }
        
        const data = await getResponse.json();
        const rows = data.values;
        
        // Find the event row
        let rowIndex = -1;
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] === eventId) {
                rowIndex = i + 1; // +1 because sheets are 1-indexed
                break;
            }
        }
        
        if (rowIndex === -1) {
            console.log(`Event ${eventId} not found for spots update`);
            return;
        }
        
        // Get current spots remaining (column J = index 9)
        const currentSpots = parseInt(rows[rowIndex - 1][9]) || 0;
        const newSpots = Math.max(0, currentSpots - 1);
        
        // Update the spots remaining
        const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Events!J${rowIndex}?valueInputOption=USER_ENTERED`;
        
        const updateResponse = await fetch(updateUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                values: [[newSpots]]
            })
        });
        
        if (updateResponse.ok) {
            console.log(`Updated spots for ${eventId}: ${currentSpots} -> ${newSpots}`);
        } else {
            console.error('Failed to update spots remaining');
        }
        
    } catch (error) {
        console.error('Error updating spots remaining:', error);
    }
}
