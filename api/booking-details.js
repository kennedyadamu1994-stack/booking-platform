// Debug version of /api/booking-details.js
// This will help us find the exact Google Sheets issue

module.exports = async (req, res) => {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }

        if (req.method !== 'GET') {
            return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
        }

        const { session_id } = req.query;
        
        console.log('API called with session_id:', session_id);

        if (!session_id) {
            return res.status(400).json({ error: 'session_id is required' });
        }

        // Check environment variables
        if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
            return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT not found' });
        }

        if (!process.env.GOOGLE_SHEET_ID) {
            return res.status(500).json({ error: 'GOOGLE_SHEET_ID not found' });
        }

        // Import googleapis
        const { google } = require('googleapis');

        // Parse credentials
        const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

        // Create auth and sheets client
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;

        console.log('Attempting to read spreadsheet metadata first...');

        // STEP 1: Get spreadsheet metadata to see all sheet names
        const metadataResponse = await sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId,
        });

        const sheetNames = metadataResponse.data.sheets.map(sheet => sheet.properties.title);
        console.log('Available sheet names:', sheetNames);

        // STEP 2: Try to read from the first sheet (whatever it's called)
        const firstSheetName = sheetNames[0];
        console.log('Trying to read from first sheet:', firstSheetName);

        const testResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: `${firstSheetName}!A1:K10`, // Just first 10 rows
        });

        const testData = testResponse.data.values;
        console.log('Successfully read data. Rows found:', testData ? testData.length : 0);
        console.log('Headers:', testData ? testData[0] : 'No data');

        // STEP 3: Check if "Events" sheet exists
        const hasEventsSheet = sheetNames.includes('Events');
        console.log('Has Events sheet:', hasEventsSheet);

        let eventsData = null;
        if (hasEventsSheet) {
            try {
                const eventsResponse = await sheets.spreadsheets.values.get({
                    spreadsheetId: spreadsheetId,
                    range: 'Events!A1:S10',
                });
                eventsData = eventsResponse.data.values;
                console.log('Events sheet data found:', eventsData ? eventsData.length : 0);
            } catch (eventsError) {
                console.log('Error reading Events sheet:', eventsError.message);
            }
        }

        // Return debug information
        return res.status(200).json({
            success: true,
            debug_info: {
                spreadsheetId: spreadsheetId,
                available_sheets: sheetNames,
                first_sheet_name: firstSheetName,
                first_sheet_rows: testData ? testData.length : 0,
                first_sheet_headers: testData ? testData[0] : null,
                has_events_sheet: hasEventsSheet,
                events_sheet_rows: eventsData ? eventsData.length : 0,
                session_id: session_id
            },
            // Still return fake calendar data for testing
            event_title: 'Debug Test Event',
            event_description: 'This is working - we can read your Google Sheets!',
            event_location: 'NBRH Location',
            start_date: '2025-01-30T10:00:00Z',
            end_date: '2025-01-30T12:00:00Z',
            amount_paid: '£25.00'
        });

    } catch (error) {
        console.error('Debug API error:', error);
        return res.status(500).json({ 
            error: 'Debug API error', 
            details: error.message,
            stack: error.stack
        });
    }
};
