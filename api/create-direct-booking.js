// Updated api/create-direct-booking.js - Works with NBRH IDs from Sessions sheet
module.exports = async (req, res) => {
    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        console.log('🎯 Starting DIRECT booking process (no payment)...');
        console.log('📨 Request payload:', JSON.stringify(req.body, null, 2));
        
        // Get booking details from the form
        // NOTE: eventId is now the NBRH ID from the Sessions sheet
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
                required: ['eventId', 'eventName', 'customerName', 'customerEmail', 'skillLevel'],
                received: { eventId, eventName, customerName, customerEmail, skillLevel }
            });
        }
        
        console.log('✅ All required fields present');
        console.log('✅ NBRH ID:', eventId);
        console.log('📝 Skill level:', skillLevel);
        
        // Check environment variables
        if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
            console.error('❌ GOOGLE_SERVICE_ACCOUNT not set');
            return res.status(500).json({ error: 'Server configuration error: Missing Google credentials' });
        }
        
        if (!process.env.SESSIONS_SHEET_ID) {
            console.error('❌ SESSIONS_SHEET_ID not set');
            return res.status(500).json({ error: 'Server configuration error: Missing Sessions Sheet ID' });
        }
        
        if (!process.env.BOOKINGS_SHEET_ID) {
            console.error('❌ BOOKINGS_SHEET_ID not set');
            return res.status(500).json({ error: 'Server configuration error: Missing Bookings Sheet ID' });
        }
        
        console.log('✅ Environment variables present');
        console.log('📋 Sessions Sheet ID:', process.env.SESSIONS_SHEET_ID);
        console.log('📋 Bookings Sheet ID:', process.env.BOOKINGS_SHEET_ID);
        
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
        console.error('Stack trace:', error.stack);
        res.status(500).json({ 
            error: 'Unable to process booking', 
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

// Function to save direct booking to Google Sheets
async function saveDirectBookingToSheets(bookingData) {
    console.log('💾 Saving direct booking to Google Sheets...');
    
    try {
        // Import googleapis
        const { google } = require('googleapis');
        
        console.log('✅ googleapis imported');
        
        // Parse credentials
        let credentials;
        try {
            credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
            console.log('✅ Service account credentials parsed');
        } catch (parseError) {
            console.error('❌ Failed to parse GOOGLE_SERVICE_ACCOUNT:', parseError);
            throw new Error('Invalid Google Service Account credentials format');
        }
        
        // Create auth and sheets client
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        console.log('✅ Google Auth created');
        
        const sheets = google.sheets({ version: 'v4', auth });
        const sessionsSheetId = process.env.SESSIONS_SHEET_ID;
        const bookingsSheetId = process.env.BOOKINGS_SHEET_ID;
        
        console.log('✅ Sheets client created');
        console.log('📋 Sessions Sheet ID:', sessionsSheetId);
        console.log('📋 Bookings Sheet ID:', bookingsSheetId);

        // STEP 1: Get session details from Sessions sheet using NBRH ID
        console.log('📋 Fetching session details from Sessions sheet...');
        console.log('📋 Looking for NBRH ID:', bookingData.eventId);
        
        let sessionsResponse;
        try {
            sessionsResponse = await sheets.spreadsheets.values.get({
                spreadsheetId: sessionsSheetId, // Read from Sessions sheet
                range: 'Sessions!A:AV', // All columns including Booking Type in Column AU
            });
            console.log('✅ Sessions sheet fetched successfully');
        } catch (fetchError) {
            console.error('❌ Failed to fetch Sessions sheet:', fetchError);
            throw new Error(`Failed to fetch Sessions sheet: ${fetchError.message}`);
        }

        const sessionRows = sessionsResponse.data.values;
        if (!sessionRows || sessionRows.length === 0) {
            console.error('❌ No data found in Sessions sheet');
            throw new Error('No data found in Sessions sheet');
        }
        
        console.log(`✅ Found ${sessionRows.length} rows in Sessions sheet`);

        // Find the session by NBRH ID (column A)
        let sessionDetails = null;
        let sessionRowIndex = -1;
        
        for (let i = 1; i < sessionRows.length; i++) {
            if (sessionRows[i][0] === bookingData.eventId) { // Column A = NBRH ID
                sessionDetails = {
                    nbrhId: sessionRows[i][0],        // A: NBRH ID
                    activityType: sessionRows[i][1],  // B: Activity Type
                    club: sessionRows[i][2],          // C: CLUB
                    className: sessionRows[i][3],     // D: Class Name
                    date: sessionRows[i][4],          // E: Date
                    startTime: sessionRows[i][5],     // F: Start Time
                    duration: sessionRows[i][6],      // G: Duration
                    address: sessionRows[i][7],       // H: Address
                    location: sessionRows[i][8],      // I: Location
                    basePrice: sessionRows[i][9],     // J: Base Price
                    totalPrice: sessionRows[i][11],   // L: Total Price
                    spotsAvailable: sessionRows[i][12], // M: Spots Available
                    totalSpots: sessionRows[i][13]    // N: Total Spots
                };
                sessionRowIndex = i + 1; // 1-based index for sheets
                console.log('✅ Found session at row:', sessionRowIndex);
                break;
            }
        }

        if (!sessionDetails) {
            console.error('❌ Session not found with NBRH ID:', bookingData.eventId);
            console.log('Available NBRH IDs in sheet:', sessionRows.slice(1, 6).map(r => r[0]));
            throw new Error(`Session not found with NBRH ID: ${bookingData.eventId}`);
        }

        console.log('✅ Session details found:', sessionDetails);

        // STEP 2: Check if spots are available
        const spotsRemaining = parseInt(sessionDetails.spotsAvailable) || 0;
        console.log('📊 Spots remaining:', spotsRemaining);
        
        if (spotsRemaining <= 0) {
            console.error('❌ No spots remaining');
            throw new Error('No spots remaining for this session');
        }

        // STEP 3: Create booking row
        const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
        
        const bookingRow = [
            bookingData.bookingId,              // A: booking_id
            currentDate,                        // B: booking_date
            bookingData.eventId,                // C: event_id (NBRH ID)
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
            sessionDetails.date || '',          // N: event_date
            sessionDetails.startTime || '',     // O: event_time  
            sessionDetails.location || ''       // P: event_location
        ];

        console.log('📝 Booking row to save:', bookingRow);

        // STEP 4: Save to Bookings sheet (in separate spreadsheet)
        console.log('💾 Saving to Bookings sheet...');
        console.log('📋 Using Bookings Sheet ID:', bookingsSheetId);
        
        const appendRequest = {
            spreadsheetId: bookingsSheetId, // Save to Bookings spreadsheet
            range: 'Bookings!A:P', // Save to Bookings tab
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: [bookingRow]
            }
        };
        
        try {
            await sheets.spreadsheets.values.append(appendRequest);
            console.log('✅ Booking saved to Bookings sheet with status "Confirmed"');
        } catch (appendError) {
            console.error('❌ Failed to append to Bookings sheet:', appendError);
            throw new Error(`Failed to save booking: ${appendError.message}`);
        }

        // STEP 5: Reduce session spots in Sessions sheet (different spreadsheet)
        const newSpots = Math.max(0, spotsRemaining - 1);
        
        console.log(`📉 Reducing spots from ${spotsRemaining} to ${newSpots}...`);
        
        try {
            await sheets.spreadsheets.values.update({
                spreadsheetId: sessionsSheetId, // Update Sessions sheet (different spreadsheet)
                range: `Sessions!M${sessionRowIndex}`, // Column M = spots_available
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [[newSpots]]
                }
            });
            
            console.log(`✅ Reduced session spots in Sessions sheet from ${spotsRemaining} to ${newSpots}`);
        } catch (updateError) {
            console.error('❌ Failed to update spots:', updateError);
            // Don't throw here - booking is already saved
            console.log('⚠️ Booking saved but spots not updated');
        }
        
        console.log('✅ Complete direct booking process finished');
        
        return { 
            bookingId: bookingData.bookingId,
            eventId: bookingData.eventId 
        };
        
    } catch (error) {
        console.error('❌ Error in saveDirectBookingToSheets:', error);
        throw error;
    }
}
