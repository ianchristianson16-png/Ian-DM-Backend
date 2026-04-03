const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

console.log('CLIENT_ID:', process.env.GOOGLE_CLIENT_ID);

const IAN_TZ = 'America/Los_Angeles';
const IAN_EMAIL = process.env.MY_EMAIL || 'ian.christianson16@gmail.com';

// ── Database ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        lead_handle TEXT NOT NULL,
        platform TEXT DEFAULT 'simulator',
        stage TEXT DEFAULT 'opened',
        status TEXT DEFAULT 'active',
        situation TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        call_booked_at TIMESTAMPTZ,
        ghosted_at TIMESTAMPTZ,
        declined_at TIMESTAMPTZ,
        call_datetime TIMESTAMPTZ,
        notes TEXT,
        user_id TEXT DEFAULT 'ian'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        stage_at_time TEXT,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stage_transitions (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id),
        from_stage TEXT,
        to_stage TEXT,
        transitioned_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id),
        lead_handle TEXT NOT NULL,
        call_datetime TIMESTAMPTZ NOT NULL,
        timezone TEXT,
        situation TEXT,
        calendar_event_id TEXT,
        email_sent BOOLEAN DEFAULT FALSE,
        text_sent BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS followups (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER REFERENCES conversations(id),
        lead_handle TEXT NOT NULL,
        followup_type TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        queued_at TIMESTAMPTZ DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        dismissed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS insights_cache (
        id SERIAL PRIMARY KEY,
        generated_at TIMESTAMPTZ DEFAULT NOW(),
        insights JSONB NOT NULL,
        week_start DATE
      );
    `);
    console.log('Database initialized');
  } catch (err) {
    console.error('DB init error:', err.message);
  } finally {
    client.release();
  }
}

initDB();

// ── Helpers ──────────────────────────────────────────────────────
function fmtInTZ(date, tz) {
  return new Date(date).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    timeZone: tz
  });
}

function buildFollowupMessage(type, leadHandle, situation) {
  const name = leadHandle.replace('@','').split('_')[0];
  const name2 = name.charAt(0).toUpperCase() + name.slice(1);
  const sit = situation || 'what you were working through';
  switch(type) {
    case '24h': return `hey ${name2} just thinking about what you said about ${sit} had a thought on that`;
    case '48h': return `yo ${name2} i posted something today that's literally exactly what we were talking about, check it out!`;
    case '72h': return `${name2}! we could fix up your ${sit} pretty quick if you're open to it.`;
    case '2week': return `${name2} random but did you end up doing anything about the ${sit} thing`;
    default: return `hey ${name2} just checking in`;
  }
}

// ── Self-improvement: analyze conversations with AI ───────────────
async function generateInsights() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;

  try {
    // Get last 30 days of conversation data
    const convData = await pool.query(`
      SELECT
        c.id, c.lead_handle, c.status, c.stage, c.situation,
        c.created_at, c.call_booked_at,
        EXTRACT(EPOCH FROM (c.call_booked_at - c.created_at))/3600 as hours_to_book,
        COUNT(m.id) as message_count,
        STRING_AGG(CASE WHEN m.role = 'lead' THEN m.content ELSE NULL END, ' | ' ORDER BY m.sent_at) as lead_messages,
        STRING_AGG(CASE WHEN m.role = 'ian' THEN m.content ELSE NULL END, ' | ' ORDER BY m.sent_at) as ian_messages,
        (SELECT to_stage FROM stage_transitions WHERE conversation_id = c.id ORDER BY transitioned_at DESC LIMIT 1) as last_stage_reached
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.created_at > NOW() - INTERVAL '30 days'
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 50
    `);

    if (convData.rows.length === 0) return null;

    const summary = {
      total: convData.rows.length,
      booked: convData.rows.filter(r => r.status === 'booked').length,
      ghosted: convData.rows.filter(r => r.status === 'ghosted').length,
      declined: convData.rows.filter(r => r.status === 'declined').length,
      active: convData.rows.filter(r => r.status === 'active').length,
    };

    const bookedConvs = convData.rows.filter(r => r.status === 'booked' && r.lead_messages);
    const ghostedConvs = convData.rows.filter(r => r.status === 'ghosted' && r.lead_messages);

    const prompt = `You are analyzing DM conversation data for Ian, a 19-year-old entrepreneur who coaches people on communication and confidence. He books strategy calls through Instagram/TikTok DMs.

Here is a summary of the last 30 days:
- Total conversations: ${summary.total}
- Calls booked: ${summary.booked}
- Ghosted: ${summary.ghosted}
- Declined: ${summary.declined}
- Still active: ${summary.active}

BOOKED conversations (what the lead said):
${bookedConvs.slice(0,10).map(c => `- Situation: "${c.situation}" | Lead said: "${(c.lead_messages||'').substring(0,300)}"`).join('\n')}

GHOSTED conversations (what the lead said before going quiet):
${ghostedConvs.slice(0,10).map(c => `- Situation: "${c.situation}" | Lead said: "${(c.lead_messages||'').substring(0,300)}"`).join('\n')}

Analyze this data and return a JSON object with these exact keys:
{
  "conversion_rate": "X%",
  "top_converting_situations": ["situation1", "situation2", "situation3"],
  "top_ghosting_situations": ["situation1", "situation2"],
  "winning_phrases": ["exact phrase from lead messages that appeared in booked convs"],
  "ghost_signals": ["exact phrases or patterns that appeared before ghosting"],
  "avg_hours_to_book": "X hours",
  "fastest_close": "describe the fastest booking pattern",
  "biggest_drop_stage": "stage where most people fall off",
  "weekly_insight": "one sharp, specific insight about what's working and what isn't, written like a smart friend giving real talk, no corporate speak, max 2 sentences",
  "recommended_tweak": "one specific suggestion to improve Ian's booking rate based on the data, max 1 sentence"
}

Return only valid JSON, no markdown, no explanation.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const insights = JSON.parse(cleaned);

    // Cache to DB
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    await pool.query(
      `INSERT INTO insights_cache (insights, week_start) VALUES ($1, $2)`,
      [JSON.stringify(insights), weekStart.toISOString().split('T')[0]]
    );

    console.log('Insights generated and cached');
    return insights;
  } catch (err) {
    console.error('Insights generation error:', err.message);
    return null;
  }
}

// ── Weekly email report ───────────────────────────────────────────
async function sendWeeklyReport() {
  if (!app.locals.tokens) { console.log('No Google tokens for weekly report'); return; }

  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'booked') as booked,
        COUNT(*) FILTER (WHERE status = 'ghosted') as ghosted,
        COUNT(*) FILTER (WHERE status = 'declined') as declined,
        COUNT(*) FILTER (WHERE stage IN ('pitch','schedule','confirm','booked')) as reached_pitch,
        ROUND(AVG(EXTRACT(EPOCH FROM (call_booked_at - created_at))/3600) FILTER (WHERE call_booked_at IS NOT NULL), 1) as avg_hours
      FROM conversations
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);

    const s = stats.rows[0];
    const convRate = s.total > 0 ? Math.round((s.booked / s.total) * 100) : 0;

    const followupStats = await pool.query(`
      SELECT followup_type, COUNT(*) as sent
      FROM followups WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '7 days'
      GROUP BY followup_type
    `);

    // Get latest insights
    const insightRow = await pool.query(`SELECT insights FROM insights_cache ORDER BY generated_at DESC LIMIT 1`);
    const insights = insightRow.rows.length > 0 ? insightRow.rows[0].insights : null;

    const weekStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: IAN_TZ });

    let body = `IAN.DM Weekly Report — Week of ${weekStr}\n\n`;
    body += `FUNNEL\n`;
    body += `Conversations started: ${s.total}\n`;
    body += `Reached pitch: ${s.reached_pitch}\n`;
    body += `Calls booked: ${s.booked}\n`;
    body += `Ghosted: ${s.ghosted}\n`;
    body += `Declined: ${s.declined}\n`;
    body += `Conversion rate: ${convRate}%\n`;
    if (s.avg_hours) body += `Avg time to book: ${s.avg_hours}h\n`;

    if (followupStats.rows.length > 0) {
      body += `\nFOLLOW-UPS SENT\n`;
      followupStats.rows.forEach(f => { body += `${f.followup_type}: ${f.sent} sent\n`; });
    }

    if (insights) {
      body += `\nINSIGHTS\n`;
      if (insights.weekly_insight) body += `This week: ${insights.weekly_insight}\n`;
      if (insights.recommended_tweak) body += `Recommendation: ${insights.recommended_tweak}\n`;
      if (insights.top_converting_situations?.length) body += `Converting best: ${insights.top_converting_situations.join(', ')}\n`;
      if (insights.winning_phrases?.length) body += `Winning phrases: ${insights.winning_phrases.slice(0,3).join(', ')}\n`;
    }

    body += `\nView full dashboard: ian-dm-followup-dashboard.html\n`;

    oauth2Client.setCredentials(app.locals.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const message = [`To: ${IAN_EMAIL}`, `Subject: IAN.DM Weekly Report`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\n');
    const encoded = Buffer.from(message).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
    console.log('Weekly report sent');
  } catch (err) {
    console.error('Weekly report error:', err.message);
  }
}

// ── Follow-up cron (runs every hour) ─────────────────────────────
async function runFollowupCron() {
  console.log('Running follow-up cron...', new Date().toISOString());
  try {
    const result = await pool.query(`
      SELECT c.id, c.lead_handle, c.situation, c.stage, c.status,
        MAX(m.sent_at) as last_message_at,
        COUNT(f.id) FILTER (WHERE f.status != 'dismissed') as followup_count,
        MAX(f.followup_type) as last_followup_type
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      LEFT JOIN followups f ON f.conversation_id = c.id
      WHERE c.status = 'active' AND c.stage != 'booked'
      GROUP BY c.id
    `);

    const now = new Date();
    for (const conv of result.rows) {
      if (!conv.last_message_at) continue;
      const hoursSince = (now - new Date(conv.last_message_at)) / (1000 * 60 * 60);
      const followupCount = parseInt(conv.followup_count) || 0;
      const lastType = conv.last_followup_type;
      let followupType = null;

      if (hoursSince >= 24 && hoursSince < 48 && followupCount === 0) followupType = '24h';
      else if (hoursSince >= 48 && hoursSince < 72 && lastType === '24h') followupType = '48h';
      else if (hoursSince >= 72 && hoursSince < 336 && lastType === '48h') followupType = '72h';
      else if (hoursSince >= 336 && lastType === '72h') followupType = '2week';
      else if (hoursSince >= 500 && lastType === '2week') {
        await pool.query(`UPDATE conversations SET status = 'ghosted', ghosted_at = NOW(), updated_at = NOW() WHERE id = $1`, [conv.id]);
        continue;
      }

      if (followupType) {
        const existing = await pool.query(`SELECT id FROM followups WHERE conversation_id = $1 AND followup_type = $2`, [conv.id, followupType]);
        if (existing.rows.length > 0) continue;
        const message = buildFollowupMessage(followupType, conv.lead_handle, conv.situation);
        await pool.query(`INSERT INTO followups (conversation_id, lead_handle, followup_type, message) VALUES ($1, $2, $3, $4)`, [conv.id, conv.lead_handle, followupType, message]);
        console.log(`Queued ${followupType} for ${conv.lead_handle}`);
      }
    }
  } catch (err) { console.error('Cron error:', err.message); }
}

// Schedule crons
setInterval(runFollowupCron, 60 * 60 * 1000);
setTimeout(runFollowupCron, 10000);

// Weekly report every Monday at 8am PST
function scheduleWeeklyReport() {
  const now = new Date();
  const pstNow = new Date(now.toLocaleString('en-US', { timeZone: IAN_TZ }));
  const daysUntilMonday = (8 - pstNow.getDay()) % 7 || 7;
  const nextMonday = new Date(pstNow);
  nextMonday.setDate(pstNow.getDate() + daysUntilMonday);
  nextMonday.setHours(8, 0, 0, 0);
  const msUntil = nextMonday - pstNow;
  setTimeout(() => {
    generateInsights().then(() => sendWeeklyReport());
    setInterval(() => generateInsights().then(() => sendWeeklyReport()), 7 * 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`Weekly report scheduled for ${nextMonday.toISOString()}`);
}
scheduleWeeklyReport();

// ── Google OAuth ──────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent',
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

// ── Now ───────────────────────────────────────────────────────────
app.get('/now', (req, res) => {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: IAN_TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
  const parts = fmt.formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value || '';
  const year = parseInt(get('year')), month = parseInt(get('month')), day = parseInt(get('day'));
  const todayStr = `${get('weekday')}, ${get('month')}/${day}/${year} at ${get('hour')}:${get('minute')} ${get('dayPeriod')} PST`;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const nextDays = [];
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now); d.setUTCHours(d.getUTCHours() + i * 24);
    const dp = new Intl.DateTimeFormat('en-US', { timeZone: IAN_TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' }).formatToParts(d);
    const dget = type => dp.find(p => p.type === type)?.value || '';
    const pad = n => String(n).padStart(2,'0');
    const dY = parseInt(dget('year')), dM = parseInt(dget('month')), dD = parseInt(dget('day'));
    nextDays.push({ label: i===0?'today':i===1?'tomorrow':dget('weekday'), weekday: dget('weekday'), date: `${dY}-${pad(dM)}-${pad(dD)}`, display: `${dget('weekday')} ${MONTHS[dM-1]} ${dD}` });
  }
  res.json({ now: todayStr, today: { year, month, day, weekday: get('weekday') }, nextDays, iso: now.toISOString() });
});

// ── Calendar ──────────────────────────────────────────────────────
app.get('/availability', async (req, res) => {
  if (!app.locals.tokens) return res.json({ availability: 'Not connected to Google Calendar yet.' });
  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const now = new Date(), weekOut = new Date(now.getTime() + 7*24*60*60*1000);
    const eventsRes = await calendar.events.list({ calendarId: 'primary', timeMin: now.toISOString(), timeMax: weekOut.toISOString(), singleEvents: true, orderBy: 'startTime' });
    const events = eventsRes.data.items || [];
    if (!events.length) return res.json({ availability: 'Calendar is open for the next 7 days.' });
    res.json({ availability: events.map(e => { const s = fmtInTZ(e.start.dateTime||e.start.date, IAN_TZ); const end = new Date(e.end.dateTime||e.end.date).toLocaleString('en-US',{hour:'numeric',minute:'2-digit',timeZone:IAN_TZ}); return `${e.summary||'Busy'}: ${s} to ${end}`; }).join('\n') });
  } catch (err) { res.json({ availability: 'Error: ' + err.message }); }
});

// ── Conversation tracking ─────────────────────────────────────────
app.post('/conversation/start', async (req, res) => {
  const { leadHandle, platform } = req.body;
  try {
    const ex = await pool.query(`SELECT id FROM conversations WHERE lead_handle=$1 AND status='active' ORDER BY created_at DESC LIMIT 1`, [leadHandle]);
    if (ex.rows.length) return res.json({ conversationId: ex.rows[0].id, resumed: true });
    const r = await pool.query(`INSERT INTO conversations (lead_handle,platform,stage,status) VALUES ($1,$2,'opened','active') RETURNING id`, [leadHandle, platform||'simulator']);
    res.json({ conversationId: r.rows[0].id, resumed: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/conversation/message', async (req, res) => {
  const { conversationId, role, content, stage } = req.body;
  try {
    await pool.query(`INSERT INTO messages (conversation_id,role,content,stage_at_time) VALUES ($1,$2,$3,$4)`, [conversationId, role, content, stage]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/conversation/stage', async (req, res) => {
  const { conversationId, fromStage, toStage } = req.body;
  try {
    await pool.query(`UPDATE conversations SET stage=$1, updated_at=NOW() WHERE id=$2`, [toStage, conversationId]);
    await pool.query(`INSERT INTO stage_transitions (conversation_id,from_stage,to_stage) VALUES ($1,$2,$3)`, [conversationId, fromStage, toStage]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/conversation/status', async (req, res) => {
  const { conversationId, status } = req.body;
  try {
    const tsField = status==='ghosted'?'ghosted_at':status==='declined'?'declined_at':null;
    if (tsField) await pool.query(`UPDATE conversations SET status=$1, ${tsField}=NOW(), updated_at=NOW() WHERE id=$2`, [status, conversationId]);
    else await pool.query(`UPDATE conversations SET status=$1, updated_at=NOW() WHERE id=$2`, [status, conversationId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Follow-ups ────────────────────────────────────────────────────
app.get('/followups', async (req, res) => {
  try {
    const r = await pool.query(`SELECT f.*, c.stage, c.situation as conv_situation FROM followups f JOIN conversations c ON c.id=f.conversation_id WHERE f.status='queued' ORDER BY f.queued_at ASC`);
    res.json({ followups: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/followups/:id/sent', async (req, res) => {
  try { await pool.query(`UPDATE followups SET status='sent', sent_at=NOW() WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/followups/:id/dismiss', async (req, res) => {
  try { await pool.query(`UPDATE followups SET status='dismissed', dismissed_at=NOW() WHERE id=$1`, [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/followups/run', async (req, res) => {
  await runFollowupCron();
  res.json({ success: true });
});

// ── Analytics ─────────────────────────────────────────────────────
app.get('/analytics/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE status!='test') as total_conversations,
        COUNT(*) FILTER (WHERE stage IN ('pitch','schedule','confirm','booked')) as reached_pitch,
        COUNT(*) FILTER (WHERE status='booked') as calls_booked,
        COUNT(*) FILTER (WHERE status='ghosted') as ghosted,
        COUNT(*) FILTER (WHERE status='declined') as declined,
        ROUND(AVG(EXTRACT(EPOCH FROM (call_booked_at-created_at))/3600) FILTER (WHERE call_booked_at IS NOT NULL),1) as avg_hours_to_book
      FROM conversations
    `);
    const dropoffs = await pool.query(`SELECT stage, COUNT(*) as count FROM conversations WHERE status IN ('active','ghosted') GROUP BY stage ORDER BY count DESC`);
    const recentBookings = await pool.query(`SELECT lead_handle, call_datetime, situation, created_at FROM bookings ORDER BY created_at DESC LIMIT 10`);
    const stageFunnel = await pool.query(`SELECT to_stage as stage, COUNT(*) as count FROM stage_transitions GROUP BY to_stage ORDER BY count DESC`);
    const followupStats = await pool.query(`SELECT followup_type, status, COUNT(*) as count FROM followups GROUP BY followup_type, status ORDER BY followup_type`);
    const weekly = await pool.query(`
      SELECT DATE_TRUNC('week', created_at) as week,
        COUNT(*) as started,
        COUNT(*) FILTER (WHERE status='booked') as booked,
        COUNT(*) FILTER (WHERE status='ghosted') as ghosted
      FROM conversations GROUP BY week ORDER BY week DESC LIMIT 8
    `);
    const insightRow = await pool.query(`SELECT insights FROM insights_cache ORDER BY generated_at DESC LIMIT 1`);
    const insights = insightRow.rows.length > 0 ? insightRow.rows[0].insights : null;
    res.json({ summary: stats.rows[0], dropoffs: dropoffs.rows, recentBookings: recentBookings.rows, stageFunnel: stageFunnel.rows, followupStats: followupStats.rows, weekly: weekly.rows, insights });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/analytics/generate-insights', async (req, res) => {
  const insights = await generateInsights();
  if (insights) res.json({ success: true, insights });
  else res.json({ success: false, message: 'Not enough data yet or generation failed' });
});

app.post('/analytics/send-report', async (req, res) => {
  await generateInsights();
  await sendWeeklyReport();
  res.json({ success: true });
});

app.get('/conversations', async (req, res) => {
  try {
    const r = await pool.query(`SELECT c.*, COUNT(m.id) as message_count, COUNT(f.id) FILTER (WHERE f.status='queued') as pending_followups FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id LEFT JOIN followups f ON f.conversation_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 100`);
    res.json({ conversations: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/conversations/:id', async (req, res) => {
  try {
    const conv = await pool.query(`SELECT * FROM conversations WHERE id=$1`, [req.params.id]);
    const messages = await pool.query(`SELECT * FROM messages WHERE conversation_id=$1 ORDER BY sent_at ASC`, [req.params.id]);
    const transitions = await pool.query(`SELECT * FROM stage_transitions WHERE conversation_id=$1 ORDER BY transitioned_at ASC`, [req.params.id]);
    const followups = await pool.query(`SELECT * FROM followups WHERE conversation_id=$1 ORDER BY queued_at ASC`, [req.params.id]);
    res.json({ conversation: conv.rows[0], messages: messages.rows, transitions: transitions.rows, followups: followups.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Book ──────────────────────────────────────────────────────────
app.post('/book', async (req, res) => {
  const { leadName, dateTime, timezone, durationMinutes, situation, conversationId } = req.body;
  if (!app.locals.tokens) return res.status(400).json({ error: 'Not connected to Google Calendar.' });
  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const tz = timezone || IAN_TZ;
    const localStr = dateTime.includes('T') ? dateTime : dateTime.replace(' ','T');
    const [datePart, timePart] = localStr.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, sec] = (timePart||'00:00:00').split(':').map(Number);
    const probe = new Date(`${datePart}T${timePart||'12:00:00'}Z`);
    const offsetMs = new Date(probe.toLocaleString('en-US',{timeZone:'UTC',hour12:false})) - new Date(probe.toLocaleString('en-US',{timeZone:tz,hour12:false}));
    const startDate = new Date(Date.UTC(year,month-1,day,hour,minute,sec||0) + offsetMs);
    const endDate = new Date(startDate.getTime() + (durationMinutes||30)*60*1000);
    const startFormatted = fmtInTZ(startDate, IAN_TZ);
    const event = await calendar.events.insert({ calendarId: 'primary', requestBody: { summary: `Strategy Call w/ ${leadName}`, description: `Situation: ${situation}\nLead timezone: ${tz}\nBooked via IAN.DM`, start: { dateTime: startDate.toISOString(), timeZone: 'UTC' }, end: { dateTime: endDate.toISOString(), timeZone: 'UTC' } } });
    let bookingId = null;
    try {
      const bR = await pool.query(`INSERT INTO bookings (conversation_id,lead_handle,call_datetime,timezone,situation,calendar_event_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [conversationId||null, leadName, startDate.toISOString(), tz, situation, event.data.id]);
      bookingId = bR.rows[0].id;
      if (conversationId) {
        await pool.query(`UPDATE conversations SET stage='booked',status='booked',call_booked_at=NOW(),call_datetime=$1,situation=$2,updated_at=NOW() WHERE id=$3`, [startDate.toISOString(), situation, conversationId]);
        await pool.query(`INSERT INTO stage_transitions (conversation_id,from_stage,to_stage) VALUES ($1,'confirm','booked')`, [conversationId]);
        await pool.query(`UPDATE followups SET status='dismissed',dismissed_at=NOW() WHERE conversation_id=$1 AND status='queued'`, [conversationId]);
      }
    } catch (dbErr) { console.error('DB booking error:', dbErr.message); }
    let emailSent = false;
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      const body = `New strategy call booked\n\nLead: ${leadName}\nTime: ${startFormatted}\nSituation: ${situation}\n\nCalendar: ${event.data.htmlLink}`;
      const msg = [`To: ${IAN_EMAIL}`, `Subject: IAN.DM: Call booked with ${leadName}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\n');
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(msg).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') } });
      emailSent = true;
    } catch (gmailErr) { console.error('Gmail error:', gmailErr.message); }
    let textSent = false, twilioError = null;
    const { TWILIO_ACCOUNT_SID: tSid, TWILIO_AUTH_TOKEN: tAuth, TWILIO_FROM: tFrom, MY_PHONE_NUMBER: tTo } = process.env;
    if (tSid && tAuth && tFrom && tTo) {
      const tRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tSid}/Messages.json`, { method: 'POST', headers: { 'Authorization': 'Basic '+Buffer.from(`${tSid}:${tAuth}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From: tFrom, To: tTo, Body: `IAN.DM: call booked\nLead: ${leadName}\nTime: ${startFormatted}\nSituation: ${situation}` }) });
      const tData = await tRes.json();
      textSent = tRes.ok && !tData.error_code;
      if (!textSent) twilioError = `${tData.error_code}: ${tData.message}`;
    }
    res.json({ success: true, eventId: event.data.id, startFormatted, emailSent, textSent, twilioError });
  } catch (err) { console.error('Book error:', err.message); res.status(500).json({ error: err.message }); }
});

// ── Anthropic proxy ───────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { messages, system } = req.body;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 380, system, messages }) });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: { message: err.message } }); }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
