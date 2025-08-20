// This file handles creating Stripe payment sessions
// Fixed redirect URL to success.html
export default async function handler(req, res) {
    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        // Get the Stripe library
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Get booking details from the form
        const { 
            eventId, 
            eventName, 
            customerName, 
            customerEmail, 
            amount, 
            addons 
        } = req.body;
        
        // Create a description for the payment
        let description = `Booking for ${eventName}`;
        if (addons && addons.length > 0) {
            description += ` (Includes: ${addons.join(', ')})`;
        }
        
        // Create Stripe checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: customerEmail,
            line_items: [
                {
                    price_data: {
                        currency: 'gbp',
                        product_data: {
                            name: eventName,
                            description: description,
                        },
                        unit_amount: Math.round(amount * 100), // Convert pounds to pence
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${process.env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.SITE_URL}?event=${eventId}`,
            metadata: {
                eventId: eventId,
                eventName: eventName,
                customerName: customerName,
                addons: addons ? addons.join(', ') : 'none'
            }
        });
        
        // Send back the checkout URL
        res.status(200).json({ url: session.url });
        
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: 'Unable to create payment session' });
    }
}
