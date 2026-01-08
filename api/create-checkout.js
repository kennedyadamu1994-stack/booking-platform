// Updated api/create-checkout.js - Works with NBRH IDs from Sessions sheet
module.exports = async (req, res) => {
    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        console.log('🚀 Starting booking process...');
        console.log('📨 Request payload:', JSON.stringify(req.body, null, 2));
        
        // Get the Stripe library
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Get booking details from the form
        // NOTE: eventId is now the NBRH ID from the Sessions sheet
        const { 
            eventId, 
            eventName, 
            customerName, 
            customerEmail, 
            skillLevel,
            amount, 
            originalAmount,
            discountCode,
            discountAmount,
            addons,
            stripeMetadata
        } = req.body;
        
        console.log('✅ Event ID (NBRH ID):', eventId);
        console.log('✅ Extracted skill level:', skillLevel);
        
        // Validate required fields
        if (!skillLevel) {
            console.error('❌ Missing skill level');
            return res.status(400).json({ error: 'Skill level is required' });
        }
        
        // Create a description for the payment
        let description = `Booking for ${eventName}`;
        if (addons && addons.length > 0) {
            description += ` (Includes: ${addons.join(', ')})`;
        }
        if (skillLevel) {
            description += ` - Skill Level: ${skillLevel}`;
        }
        
        console.log('💳 Creating Stripe checkout session...');
        
        // Create Stripe checkout session with ALL booking data in metadata
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
                // CRITICAL: Store ALL booking data here for webhook to save after payment
                eventId: eventId, // This is the NBRH ID
                eventName: eventName,
                customerName: customerName,
                customerEmail: customerEmail,
                skillLevel: skillLevel,
                addons: addons ? addons.join(', ') : 'None',
                amount: amount.toString(),
                originalAmount: originalAmount ? originalAmount.toString() : amount.toString(),
                discountCode: discountCode || 'None',
                discountAmount: discountAmount ? discountAmount.toString() : '0'
            }
        });
        
        console.log('✅ Stripe session created:', session.id);
        console.log('🎯 Booking will be saved AFTER payment in webhook');
        
        // Send back the checkout URL
        console.log('🎯 Returning checkout URL');
        res.status(200).json({ url: session.url });
        
    } catch (error) {
        console.error('❌ Booking process error:', error);
        res.status(500).json({ error: 'Unable to create booking session' });
    }
};
