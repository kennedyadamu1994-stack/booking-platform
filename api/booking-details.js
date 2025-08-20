// API Endpoint: /api/booking-details.js
// Updated with better error handling

export default async function handler(req, res) {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    try {
        const { session_id } = req.query;
        
        if (!session_id) {
            return res.status(400).json({ error: 'session_id is required' });
        }

        // Import googleapis dynamically
        const { google } = await import('googleapis');

        // Check environment variables
        if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
            console.error('Missing GOOGLE_SERVICE_ACCOUNT environment variable');
            return res.status(500).json({ error: 'Google credentials not configured' });
        }

        if (!process.env.GOOGLE_SHEET_ID) {
            console.error('Missing GOOGLE_SHEET_ID environment variable');
            return res.status(500).json({ error: 'Google Sheet ID not configured' });
        }

        // Parse Google credentials
        let credentials;
        try {
            credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
        } catch (err) {
            console.error('Error parsing GOOGLE_SERVICE_ACCOUNT:', err);
            return res.status(500).json({ error: 'Invalid Google credentials format' });
        }

        // Use your existing environment variables
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;

        console.log('Attempting to read from spreadsheet:', spreadsheetId);

        // Read both sheets with error handling
        let bookingResponse, eventsResponse;
        
        try {
            [bookingResponse, eventsResponse] = await Promise.all([
                sheets.spreadsheets.values.get({
                    spreadsheetId: spreadsheetId,
                    range: 'Sheet1!A:K', // Your booking log sheet
                }),
                sheets.spreadsheets.values.get({
                    spreadsheetId: spreadsheetId,
                    range: 'Events!A:S', // Your events sheet
                })
            ]);
        } catch (sheetsError) {
            console.error('Error reading from Google Sheets:', sheetsError);
            return res.status(500).json({ 
                error: 'Failed to read from Google Sheets', 
                details: sheetsError.message 
            });
        }

        const bookingRows = bookingResponse.data.values;
        const eventRows = eventsResponse.data.values;

        console.log('Booking rows found:', bookingRows ? bookingRows.length : 0);
        console.log('Event rows found:', eventRows ? eventRows.length : 0);

        if (!bookingRows || bookingRows.length === 0) {
            return res.status(404).json({ error: 'No booking data found in Sheet1' });
        }

        if (!eventRows || eventRows.length === 0) {
            return res.status(404).json({ error: 'No event data found in Events sheet' });
        }

        // Find the booking by stripe_payment_id
        const bookingHeaders = bookingRows[0];
        console.log('Booking headers:', bookingHeaders);
        
        const stripePaymentIdIndex = bookingHeaders.indexOf('stripe_payment_id');
        if (stripePaymentIdIndex === -1) {
            return res.status(500).json({ error: 'stripe_payment_id column not found in booking sheet' });
        }

        const bookingRow = bookingRows.find(row => {
            return row[stripePaymentIdIndex] === session_id;
        });

        if (!bookingRow) {
            console.log('Booking not found for session_id:', session_id);
            return res.status(404).json({ error: 'Booking not found for this session_id' });
        }

        console.log('Found booking row:', bookingRow);

        // Get the event_id from the booking
        const eventIdIndex = bookingHeaders.indexOf('event_id');
        if (eventIdIndex === -1) {
            return res.status(500).json({ error: 'event_id column not found in booking sheet' });
        }
        
        const eventId = bookingRow[eventIdIndex];
        console.log('Looking for event_id:', eventId);

        // Find the event details by event_id
        const eventHeaders = eventRows[0];
        console.log('Event headers:', eventHeaders);
        
        const eventIdHeaderIndex = eventHeaders.indexOf('event_id');
        if (eventIdHeaderIndex === -1) {
            return res.status(500).json({ error: 'event_id column not found in Events sheet' });
        }

        const eventRow = eventRows.find(row => {
            return row[eventIdHeaderIndex] === eventId;
        });

        if (!eventRow) {
            console.log('Event not found for event_id:', eventId);
            return res.status(404).json({ error: 'Event details not found for this event_id' });
        }

        console.log('Found event row:', eventRow);

        // Combine booking and event data
        const bookingDetails = combineBookingAndEventData(bookingHeaders, bookingRow, eventHeaders, eventRow);

        console.log('Returning booking details:', bookingDetails);
        res.status(200).json(bookingDetails);

    } catch (error) {
        console.error('Unexpected error in booking-details API:', error);
        res.status(500).json({ 
            error: 'Internal server error', 
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
}

// Helper function to combine booking and event data
function combineBookingAndEventData(bookingHeaders, bookingRow, eventHeaders, eventRow) {
    // Helper to get values from either sheet
    const getBookingValue = (columnName) => {
        const index = bookingHeaders.indexOf(columnName);
        return index !== -1 ? bookingRow[index] : null;
    };

    const getEventValue = (columnName) => {
        const index = eventHeaders.indexOf(columnName);
        return index !== -1 ? eventRow[index] : null;
    };

    // Get event details from Events sheet
    const eventName = getEventValue('event_name') || 'Your Booked Event';
    const eventDescription = getEventValue('description') || `Thank you for booking ${eventName}!`;
    const eventDate = getEventValue('date'); // e.g., "30/01/2025"
    const eventTime = getEventValue('time'); // e.g., "10:00 AM"
    const eventLocation = getEventValue('location') || 'NBRH - Location TBC';

    // Build full description with addons
    const addons = getBookingValue('addons_selected');
    let fullDescription = eventDescription;
    if (addons && addons !== 'None') {
        fullDescription += `\n\nIncluded Add-ons: ${addons}`;
    }

    // Convert date and time to ISO format for calendar
    const { startDate, endDate } = convertToISODates(eventDate, eventTime);

    return {
        // Event details
        event_title: eventName,
        event_description: fullDescription,
        event_location: eventLocation,
        start_date: startDate,
        end_date: endDate,

        // Booking details
        amount_paid: getBookingValue('amount_paid') ? `£${getBookingValue('amount_paid')}` : null,
        customer_name: getBookingValue('customer_name'),
        customer_email: getBookingValue('customer_email'),
        booking_id: getBookingValue('booking_id'),
        booking_date: getBookingValue('booking_date'),
        event_id: getBookingValue('event_id'),
        addons_selected: addons,
        stripe_payment_id: getBookingValue('stripe_payment_id'),
        status: getBookingValue('status'),

        // Event pricing details  
        base_price: getEventValue('base_price'),
        instruction_fee: getEventValue('instruction_fee'),
        total_spots: getEventValue('total_spots'),
        spots_remaining: getEventValue('spots_remaining'),
    };
}

// Helper function to convert date/time to ISO format
function convertToISODates(dateStr, timeStr) {
    try {
        if (!dateStr || !timeStr) {
            throw new Error('Missing date or time');
        }

        // Handle date format like "30/01/2025" 
        const [day, month, year] = dateStr.split('/');

        // Handle time format like "10:00 AM"
        let [time, period] = timeStr.split(' ');
        let [hours, minutes] = time.split(':');

        // Convert to 24-hour format
        if (period === 'PM' && hours !== '12') {
            hours = parseInt(hours) + 12;
        } else if (period === 'AM' && hours === '12') {
            hours = '00';
        }

        // Create ISO date string
        const startDate = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hours.padStart(2, '0')}:${minutes}:00.000Z`);

        // Assume 2-hour duration (adjust as needed)
        const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

        return {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString()
        };
    } catch (error) {
        console.error('Error converting date/time:', error);
        // Fallback to tomorrow at 10 AM
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(10, 0, 0, 0);

        const endTomorrow = new Date(tomorrow.getTime() + 2 * 60 * 60 * 1000);

        return {
            startDate: tomorrow.toISOString(),
            endDate: endTomorrow.toISOString()
        };
    }
}
