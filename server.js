const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

console.log('CLIENT_ID:', process.env.GOOGLE_CLIENT_ID);

const IAN_TZ = 'America/Los_Angeles';

// PST offset in ms (-7 hours standard, -8 PDT — use Intl to get the real offset)
function getPSTOffset() {
  const now = new Date();
  const pstString = now.toLocaleString('en-US', { timeZone: IAN_TZ, hour12: false });
  const utcString = now.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
  return (new Date(utcString) - new Date(pstString));
}

function fmtInTZ(date, tz) {
  return new Date(date).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    timeZone: tz
  });
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  app.locals.tokens = tokens;
  res.send(`<h2 style="font-family:sans-serif;padding:40px">Connected to Google Calendar. You can close this tab.</h2>`);
});

// Return current date/time in PST — used by simulator so AI gets the right date
app.get('/now', (req, res) => {
  const now = new Date();
  // Get each date component in PST
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IAN_TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).formatToParts(now);

  const get = type => parts.find(p => p.type === type)?.value || '';
  const pstStr = `${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')} at ${get('hour')}:${get('minute')} ${get('dayPeriod')} PST`;

  // Also return ISO components in PST for date calculation
  const pstDate = new Date(now.toLocaleString('en-US', { timeZone: IAN_TZ }));

  res.json({
    now: pstStr,
    iso: now.toISOString(),
    pstYear: pstDate.getFullYear(),
    pstMonth: pstDate.getMonth() + 1,
    pstDay: pstDate.getDate(),
    pstWeekday: get('weekday')
  });
});

// Get busy times for next 7 days in PST
app.get('/availability', async (req, res) => {
  if (!app.locals.tokens) {
    return res.json({ availability: 'Not connected to Google Calendar yet.' });
  }
  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const now = new Date();
    const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const eventsRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: weekOut.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = eventsRes.data.items || [];
    if (events.length === 0) {
      return res.json({ availability: 'Calendar is open for the next 7 days.' });
    }

    const busyText = events.map(e => {
      const startRaw = e.start.dateTime || e.start.date;
      const endRaw = e.end.dateTime || e.end.date;
      const start = fmtInTZ(startRaw, IAN_TZ);
      const end = new Date(endRaw).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: IAN_TZ
      });
      return `${e.summary || 'Busy'}: ${start} to ${end}`;
    }).join('\n');

    res.json({ availability: busyText });
  } catch (err) {
    res.json({ availability: 'Error reading calendar: ' + err.message });
  }
});

// Book a call
app.post('/book', async (req, res) => {
  const { leadName, dateTime, timezone, durationMinutes, situation } = req.body;
  console.log('Book request:', JSON.stringify({ leadName, dateTime, timezone, situation }));

  if (!app.locals.tokens) {
    return res.status(400).json({ error: 'Not connected to Google Calendar.' });
  }

  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const tz = timezone || IAN_TZ;

    // dateTime is "YYYY-MM-DDTHH:MM:SS" in the lead's local timezone
    // We need to convert it to UTC properly using the timezone
    // Strategy: interpret the datetime string AS IF it's in the given timezone
    const localDateStr = dateTime.includes('T') ? dateTime : dateTime.replace(' ', 'T');

    // Build a proper UTC date by using Intl to get the offset
    // Parse the local time parts
    const [datePart, timePart] = localDateStr.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second] = (timePart || '00:00:00').split(':').map(Number);

    // Create a reference date in the target timezone to find the UTC offset
    const refDate = new Date(`${datePart}T${timePart || '00:00:00'}Z`);
    const tzString = refDate.toLocaleString('en-US', { timeZone: tz, hour12: false });
    const utcString = refDate.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
    const offsetMs = new Date(utcString) - new Date(tzString);

    // Apply offset to get UTC
    const localMs = Date.UTC(year, month - 1, day, hour, minute, second || 0);
    const utcMs = localMs + offsetMs;
    const startDate = new Date(utcMs);
    const endDate = new Date(startDate.getTime() + (durationMinutes || 30) * 60 * 1000);

    const startFormatted = fmtInTZ(startDate, IAN_TZ);
    console.log('Booking:', { localInput: localDateStr, tz, utc: startDate.toISOString(), displayPST: startFormatted });

    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: `Strategy Call w/ ${leadName}`,
        description: `Situation: ${situation}\nLead timezone: ${tz}\nBooked via IAN.DM`,
        start: { dateTime: startDate.toISOString(), timeZone: 'UTC' },
        end: { dateTime: endDate.toISOString(), timeZone: 'UTC' },
      },
    });

    console.log('Calendar event created:', event.data.id, startFormatted);

    // Twilio
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_FROM;
    const twilioTo = process.env.MY_PHONE_NUMBER;

    let textSent = false;
    let twilioError = null;

    if (twilioSid && twilioAuth && twilioFrom && twilioTo) {
      const msgBody = `IAN.DM: call booked\nLead: ${leadName}\nTime: ${startFormatted}\nSituation: ${situation}`;
      console.log('Sending text:', { to: twilioTo, from: twilioFrom });

      const twilioRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioAuth}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ From: twilioFrom, To: twilioTo, Body: msgBody }),
        }
      );
      const twilioData = await twilioRes.json();
      console.log('Twilio response:', JSON.stringify(twilioData));
      textSent = twilioRes.ok && !twilioData.error_code;
      if (!textSent) twilioError = `${twilioData.error_code}: ${twilioData.message || twilioData.error_message}`;
    } else {
      console.log('Twilio vars missing:', { sid: !!twilioSid, auth: !!twilioAuth, from: twilioFrom, to: twilioTo });
    }

    res.json({ success: true, eventId: event.data.id, startFormatted, textSent, twilioError });
  } catch (err) {
    console.error('Book error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  const { messages, system } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 380, system, messages }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
