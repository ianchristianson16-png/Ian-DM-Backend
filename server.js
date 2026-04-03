const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

// ── Google Calendar ──────────────────────────────────────────────
console.log('CLIENT_ID:', process.env.GOOGLE_CLIENT_ID);
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Step 1: redirect user to Google login
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  res.redirect(url);
});

// Step 2: Google sends back a code, we swap it for tokens
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  // Save tokens in memory (good enough for single user)
  app.locals.tokens = tokens;
  res.send(`
    <h2 style="font-family:sans-serif;padding:40px">
      Connected to Google Calendar. You can close this tab.
    </h2>
  `);
});

// Get free slots for the next 7 days
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
    const busy = events.map(e => ({
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      title: e.summary || 'Busy',
    }));

    // Build a plain English summary of busy times
    const busyText = busy.length === 0
      ? 'No events found, calendar appears open.'
      : busy.map(b => {
          const start = new Date(b.start).toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short' });
          const end = new Date(b.end).toLocaleString('en-US', { hour:'numeric', minute:'2-digit' });
          return `${b.title}: ${start} to ${end}`;
        }).join('\n');

    res.json({ availability: busyText });
  } catch (err) {
    res.json({ availability: 'Error reading calendar: ' + err.message });
  }
});

// Proxy Anthropic API calls (keeps API key server-side)
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
