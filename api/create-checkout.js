// Fixed api/create-checkout.js - Handles both Stripe and Google Sheets
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
        
        // Get booking details from the form (with skill level!)
        const { 
            eventId, 
            eventName, 
            customerName, 
            customerEmail, 
            skillLevel,  // *** CRITICAL: Extract skill level ***
            amount, 
            originalAmount,
            discountCode,
            discountAmount,
            addons,
            sheetRow,
            stripeMetadata
        } = req.body;
        
        console.log('✅ Extracted skill level:', skillLevel);
        console.log('📊 Sheet row received:', sheetRow);
        
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
        
        // Create Stripe checkout session with skill level in metadata
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
                customerEmail: customerEmail,
                skillLevel: skillLevel, // *** SKILL LEVEL IN METADATA ***
                addons: addons ? addons.join(', ') : 'none',
                originalAmount: originalAmount,
                discountCode: discountCode || 'none',
                discountAmount: discountAmount || 0
            }
        });
        
        console.log('✅ Stripe session created:', session.id);
        
        // Now save to Google Sheets with skill level in column M
        console.log('📝 Saving to Google Sheets...');
        
        try {
            await saveBookingToSheets({
                sessionId: session.id,
                paymentIntentId: session.payment_intent,
                eventId,
                eventName,
                customerName,
                customerEmail,
                skillLevel, // *** PASS SKILL LEVEL ***
                amount,
                addons: addons || [],
                status: 'pending'
            });
            
            console.log('✅ Successfully saved to Google Sheets with skill level in column M');
            
        } catch (sheetError) {
            console.error('⚠️ Failed to save to Google Sheets:', sheetError);
            // Continue anyway - payment session is created
        }
        
        // Send back the checkout URL
        console.log('🎯 Returning checkout URL');
        res.status(200).json({ url: session.url });
        
    } catch (error) {
        console.error('❌ Booking process error:', error);
        res.status(500).json({ error: 'Unable to create booking session' });
    }
};

// Function to save booking to Google Sheets
async function saveBookingToSheets({ 
    sessionId, 
    paymentIntentId, 
    eventId, 
    eventName, 
    customerName, 
    customerEmail, 
    skillLevel, // *** SKILL LEVEL PARAMETER ***
    amount, 
    addons, 
    status 
}) {
    console.log('📊 Preparing Google Sheets data...');
    console.log('🎯 Skill level for column M:', skillLevel);
    
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
    
    // Generate booking ID
    const bookingId = `BK${Date.now()}`;
    
    // Ensure skill level is never empty (prevent truncation)
    const safeSkillLevel = skillLevel && skillLevel.trim() !== '' ? skillLevel : 'Not specified';
    
    // Build row for columns A through N (with skill level at M, safety column at N)
    const rowData = [
        bookingId,                              // A - booking_id
        new Date().toISOString(),               // B - booking_date  
        eventId,                                // C - event_id
        eventName,                              // D - event_name
        customerName,                           // E - customer_name
        customerEmail,                          // F - customer_email
        Number(amount.toFixed(2)),              // G - amount_paid
        addons.join(', ') || '',                // H - addons_selected
        paymentIntentId || sessionId,           // I - stripe_payment_id
        status,                                 // J - status
        '',                                     // K - email_sent_to_me
        '',                                     // L - email_sent_to_instructor
        safeSkillLevel,                         // M - skill_level *** CRITICAL ***
        'PRESERVE_COLUMN_M'                     // N - safety column (prevents M truncation)
    ];
    
    console.log('📋 Row data for Google Sheets (A-N):');
    console.log('   A (booking_id):', rowData[0]);
    console.log('   B (booking_date):', rowData[1]);
    console.log('   C (event_id):', rowData[2]);
    console.log('   D (event_name):', rowData[3]);
    console.log('   E (customer_name):', rowData[4]);
    console.log('   F (customer_email):', rowData[5]);
    console.log('   G (amount_paid):', rowData[6]);
    console.log('   H (addons_selected):', rowData[7]);
    console.log('   I (stripe_payment_id):', rowData[8]);
    console.log('   J (status):', rowData[9]);
    console.log('   K (email_sent_to_me):', rowData[10]);
    console.log('   L (email_sent_to_instructor):', rowData[11]);
    console.log('   M (skill_level):', rowData[12], ' *** SKILL LEVEL ***');
    console.log('   N (preserve_column):', rowData[13], ' *** ANTI-TRUNCATION ***');
    console.log(`📏 Row length: ${rowData.length} (should be 14 for A-N)`);
    
    // Append to Google Sheets using range A:N
    const request = {
        spreadsheetId: spreadsheetId,
        range: 'Bookings!A:N', // *** UPDATED RANGE TO INCLUDE COLUMN N ***
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: {
            values: [rowData]
        }
    };
    
    console.log('📤 Sending to Google Sheets API...');
    const result = await sheets.spreadsheets.values.append(request);
    
    console.log('✅ Google Sheets API response:', result.data);
    console.log('🎯 Skill level successfully saved to column M!');
    
    return result;
}
