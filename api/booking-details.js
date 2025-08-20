// API Endpoint: /api/booking-details.js
// This works with your existing Vercel environment variables

const { google } = require('googleapis');

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    try {
        const { session_id } = req.query;
        
        if (!session_id) {
            return res.status(400).json({ error: 'session_id is required' });
        }

        // Use your existing environment variables
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;

        // Read both sheets
        const [bookingResponse, eventsResponse] = await Promise.all([
            sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: 'Sheet1!A:K', // Your booking log sheet
            }),
            sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: 'Events!A:S', // Your events sheet
            })
        ]);

        const bookingRows = bookingResponse.data.values;
        const eventRows = eventsResponse.data.values;

        if (!bookingRows || bookingRows.length === 0) {
            return res.status(404).json({ error: 'No booking data found' });
        }

        if (!eventRows || eventRows.length === 0) {
            return res.status(404).json({ error: 'No event data found' });
        }

        // Find the booking by stripe_payment_id
        const bookingHeaders = bookingRows[0];
        const bookingRow = bookingRows.find(row => {
            const stripePaymentIdIndex = bookingHeaders.indexOf('stripe_payment_id');
            return row[stripePaymentIdIndex] === session_id;
        });

        if (!bookingRow) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        // Get the event_id from the booking
        const eventIdIndex = bookingHeaders.indexOf('event_id');
        const eventId = bookingRow[eventIdIndex];

        // Find the event details by event_id
        const eventHeaders = eventRows[0];
        const eventRow = eventRows.find(row => {
            const eventIdIndex = eventHeaders.indexOf('event_id');
            return row[eventIdIndex] === eventId;
        });

        if (!eventRow) {
            return res.status(404).json({ error: 'Event details not found' });
        }

        // Combine booking and event data
        const bookingDetails = combineBookingAndEventData(bookingHeaders, bookingRow, eventHeaders, eventRow);

        res.json(bookingDetails);

    } catch (error) {
        console.error('Error fetching booking details:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
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
