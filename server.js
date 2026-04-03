const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

console.log('CLIENT_ID:', process.env.GOOGLE_CLIENT_ID);

const IAN_TZ = 'America/Los_Angeles';

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

// Helper: format a date in PST with full readable label
function fmtPST(dateStr) {
  return new Date(dateStr).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    timeZone: IAN_TZ
  });
}

// Get current date/time info in PST for the AI
app.get('/now', (req, res) => {
  const now = new Date();
  const pst = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    timeZone: IAN_TZ
  });
  res.json({ now: pst, iso: now.toISOString() });
});

// Get busy times for next 7 days — all times shown in PST
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
      timeZone: IAN_TZ,
    });

    const events = eventsRes.data.items || [];

    if (events.length === 0) {
      return res.json({ availability: 'Calendar is open for the next 7 days.' });
    }

    const busyText = events.map(e => {
      const start = fmtPST(e.start.dateTime || e.start.date);
      const end = new Date(e.end.dateTime || e.end.date).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        timeZone: IAN_TZ
      });
      return `${e.summary || 'Busy'}: ${start} to ${end}`;
    }).join('\n');

    res.json({ availability: busyText });
  } catch (err) {
    res.json({ availability: 'Error reading calendar: ' + err.message });
  }
});

// Book a call: create calendar event + send Twilio text
app.post('/book', async (req, res) => {
  const { leadName, dateTime, timezone, durationMinutes, situation } = req.body;

  console.log('Book request:', { leadName, dateTime, timezone, situation });

  if (!app.locals.tokens) {
    return res.status(400).json({ error: 'Not connected to Google Calendar.' });
  }

  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const tz = timezone || IAN_TZ;

    // dateTime is local time in lead's timezone e.g. "2026-04-06T15:00:00"
    const startDate = new Date(dateTime);
    const endDate = new Date(startDate.getTime() + (durationMinutes || 30) * 60 * 1000);

    // Show the booked time in Ian's timezone (PST)
    const startFormatted = fmtPST(startDate.toISOString());

    console.log('Creating event:', { start: startDate.toISOString(), tz, startFormatted });

    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: `Strategy Call w/ ${leadName}`,
        description: `Lead situation: ${situation}\n\nLead timezone: ${tz}\nBooked via IAN.DM`,
        start: { dateTime: startDate.toISOString(), timeZone: tz },
        end: { dateTime: endDate.toISOString(), timeZone: tz },
      },
    });

    console.log('Event created:', event.data.id);

    // Twilio text
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_FROM;
    const twilioTo = process.env.MY_PHONE_NUMBER;

    let textSent = false;
    let twilioError = null;

    if (twilioSid && twilioAuth && twilioFrom && twilioTo) {
      const msgBody = `IAN.DM: call booked\nLead: ${leadName}\nTime: ${startFormatted}\nSituation: ${situation}`;
      console.log('Sending Twilio text to:', twilioTo, 'from:', twilioFrom);

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
      console.log('Twilio full response:', JSON.stringify(twilioData));
      textSent = twilioRes.ok && !twilioData.error_code;
      if (!textSent) twilioError = twilioData.message || twilioData.error_message;
    } else {
      console.log('Twilio vars missing:', { twilioSid: !!twilioSid, twilioAuth: !!twilioAuth, twilioFrom, twilioTo });
    }

    res.json({
      success: true,
      eventId: event.data.id,
      eventLink: event.data.htmlLink,
      startFormatted,
      textSent,
      twilioError
    });

  } catch (err) {
    console.error('Book error:', err.message);
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
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 380,
        system,
        messages,
      }),
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
