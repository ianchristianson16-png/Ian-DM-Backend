const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

console.log('CLIENT_ID:', process.env.GOOGLE_CLIENT_ID);

const IAN_TZ = 'America/Los_Angeles';
const IAN_EMAIL = process.env.MY_EMAIL || 'ian.christianson16@gmail.com';

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
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  app.locals.tokens = tokens;
  res.send(`<h2 style="font-family:sans-serif;padding:40px">Connected to Google Calendar + Gmail. You can close this tab.</h2>`);
});

app.get('/now', (req, res) => {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: IAN_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true
  });
  const parts = fmt.formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value || '';
  const year = parseInt(get('year'));
  const month = parseInt(get('month'));
  const day = parseInt(get('day'));
  const weekday = get('weekday');
  const todayStr = `${weekday}, ${get('month')}/${day}/${year} at ${get('hour')}:${get('minute')} ${get('dayPeriod')} PST`;

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const nextDays = [];
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now);
    d.setUTCHours(d.getUTCHours() + i * 24);
    const dp = new Intl.DateTimeFormat('en-US', {
      timeZone: IAN_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long'
    }).formatToParts(d);
    const dget = type => dp.find(p => p.type === type)?.value || '';
    const dYear = parseInt(dget('year'));
    const dMonth = parseInt(dget('month'));
    const dDay = parseInt(dget('day'));
    const dWeekday = dget('weekday');
    const pad = n => String(n).padStart(2, '0');
    nextDays.push({
      label: i === 0 ? 'today' : i === 1 ? 'tomorrow' : dWeekday,
      weekday: dWeekday,
      date: `${dYear}-${pad(dMonth)}-${pad(dDay)}`,
      display: `${dWeekday} ${MONTHS[dMonth-1]} ${dDay}`
    });
  }

  res.json({ now: todayStr, today: { year, month, day, weekday }, nextDays, iso: now.toISOString() });
});

app.get('/availability', async (req, res) => {
  if (!app.locals.tokens) return res.json({ availability: 'Not connected to Google Calendar yet.' });
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
    if (events.length === 0) return res.json({ availability: 'Calendar is open for the next 7 days.' });
    const busyText = events.map(e => {
      const start = fmtInTZ(e.start.dateTime || e.start.date, IAN_TZ);
      const end = new Date(e.end.dateTime || e.end.date).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: IAN_TZ
      });
      return `${e.summary || 'Busy'}: ${start} to ${end}`;
    }).join('\n');
    res.json({ availability: busyText });
  } catch (err) {
    res.json({ availability: 'Error reading calendar: ' + err.message });
  }
});

// Send Gmail notification
async function sendGmail(subject, body) {
  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const message = [
      `To: ${IAN_EMAIL}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
    ].join('\n');
    const encoded = Buffer.from(message).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
    console.log('Gmail sent to', IAN_EMAIL);
    return true;
  } catch (err) {
    console.error('Gmail error:', err.message);
    return false;
  }
}

app.post('/book', async (req, res) => {
  const { leadName, dateTime, timezone, durationMinutes, situation } = req.body;
  console.log('Book request:', JSON.stringify({ leadName, dateTime, timezone, situation }));

  if (!app.locals.tokens) return res.status(400).json({ error: 'Not connected to Google Calendar.' });

  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const tz = timezone || IAN_TZ;

    const localStr = dateTime.includes('T') ? dateTime : dateTime.replace(' ', 'T');
    const [datePart, timePart] = localStr.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, sec] = (timePart || '00:00:00').split(':').map(Number);

    const probe = new Date(`${datePart}T${timePart || '12:00:00'}Z`);
    const localFormatted = probe.toLocaleString('en-US', { timeZone: tz, hour12: false });
    const utcFormatted = probe.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
    const offsetMs = new Date(utcFormatted) - new Date(localFormatted);

    const localMs = Date.UTC(year, month - 1, day, hour, minute, sec || 0);
    const startDate = new Date(localMs + offsetMs);
    const endDate = new Date(startDate.getTime() + (durationMinutes || 30) * 60 * 1000);
    const startFormatted = fmtInTZ(startDate, IAN_TZ);

    console.log('Booking:', { utc: startDate.toISOString(), pst: startFormatted });

    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: `Strategy Call w/ ${leadName}`,
        description: `Situation: ${situation}\nLead timezone: ${tz}\nBooked via IAN.DM`,
        start: { dateTime: startDate.toISOString(), timeZone: 'UTC' },
        end: { dateTime: endDate.toISOString(), timeZone: 'UTC' },
      },
    });

    console.log('Event created:', event.data.id);

    // Gmail notification
    const emailSubject = `IAN.DM: Call booked with ${leadName}`;
    const emailBody = `New strategy call booked via IAN.DM\n\nLead: ${leadName}\nTime: ${startFormatted}\nSituation: ${situation}\n\nCalendar event: ${event.data.htmlLink}`;
    const emailSent = await sendGmail(emailSubject, emailBody);

    // Twilio (will work once toll-free verification approved)
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_FROM;
    const twilioTo = process.env.MY_PHONE_NUMBER;

    let textSent = false;
    let twilioError = null;

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
      console.log('Twilio:', JSON.stringify(twilioData));
      textSent = twilioRes.ok && !twilioData.error_code;
      if (!textSent) twilioError = `${twilioData.error_code}: ${twilioData.message || twilioData.error_message}`;
    }

    res.json({ success: true, eventId: event.data.id, startFormatted, emailSent, textSent, twilioError });
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
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
