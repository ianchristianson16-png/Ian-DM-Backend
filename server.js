const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

console.log('CLIENT_ID:', process.env.GOOGLE_CLIENT_ID);

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
    const busyText = events.length === 0
      ? 'No events found, calendar appears open.'
      : events.map(e => {
          const start = new Date(e.start.dateTime || e.start.date).toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
            timeZone: 'America/Los_Angeles'
          });
          const end = new Date(e.end.dateTime || e.end.date).toLocaleString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles'
          });
          return `${e.summary || 'Busy'}: ${start} to ${end}`;
        }).join('\n');
    res.json({ availability: busyText });
  } catch (err) {
    res.json({ availability: 'Error reading calendar: ' + err.message });
  }
});

app.post('/book', async (req, res) => {
  const { leadName, dateTime, timezone, durationMinutes, situation } = req.body;

  if (!app.locals.tokens) {
    return res.status(400).json({ error: 'Not connected to Google Calendar.' });
  }

  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Use the lead's timezone to interpret the datetime correctly
    const tz = timezone || 'America/Los_Angeles';

    // dateTime comes in as "2026-04-04T11:00:00" (local time in lead's tz)
    // We pass it directly to Google Calendar with the timezone — Google handles conversion
    const startLocal = dateTime.includes('Z') ? dateTime : dateTime.replace(' ', 'T');
    const startDate = new Date(startLocal);
    const endDate = new Date(startDate.getTime() + (durationMinutes || 30) * 60 * 1000);

    // Format for display in PST (Ian's timezone)
    const startFormatted = startDate.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      timeZone: tz
    });

    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: `Strategy Call w/ ${leadName}`,
        description: `Lead situation: ${situation}\n\nBooked via IAN.DM\nLead timezone: ${tz}`,
        start: { dateTime: startDate.toISOString(), timeZone: tz },
        end: { dateTime: endDate.toISOString(), timeZone: tz },
      },
    });

    // Send text via Twilio
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_FROM;
    const twilioTo = process.env.MY_PHONE_NUMBER;

    let textSent = false;
    if (twilioSid && twilioAuth && twilioFrom && twilioTo) {
      const msgBody = `IAN.DM: call booked\nLead: ${leadName}\nTime: ${startFormatted}\nSituation: ${situation}`;
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
      textSent = twilioRes.ok;
      console.log('Twilio response:', JSON.stringify(twilioData));
    }

    res.json({ success: true, eventId: event.data.id, eventLink: event.data.htmlLink, textSent, startFormatted });
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
