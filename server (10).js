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

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY, lead_handle TEXT NOT NULL, platform TEXT DEFAULT 'simulator',
        stage TEXT DEFAULT 'opened', status TEXT DEFAULT 'active', situation TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        call_booked_at TIMESTAMPTZ, ghosted_at TIMESTAMPTZ, declined_at TIMESTAMPTZ,
        call_datetime TIMESTAMPTZ, notes TEXT, user_id TEXT DEFAULT 'ian',
        is_icp BOOLEAN DEFAULT FALSE, icp_flagged_at TIMESTAMPTZ,
        icp_pain_point BOOLEAN DEFAULT FALSE, icp_money BOOLEAN DEFAULT FALSE, icp_urgency BOOLEAN DEFAULT FALSE,
        show_rate TEXT DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY, conversation_id INTEGER REFERENCES conversations(id),
        role TEXT NOT NULL, content TEXT NOT NULL, stage_at_time TEXT, sent_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS stage_transitions (
        id SERIAL PRIMARY KEY, conversation_id INTEGER REFERENCES conversations(id),
        from_stage TEXT, to_stage TEXT, transitioned_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY, conversation_id INTEGER REFERENCES conversations(id),
        lead_handle TEXT NOT NULL, call_datetime TIMESTAMPTZ NOT NULL, timezone TEXT,
        situation TEXT, calendar_event_id TEXT, email_sent BOOLEAN DEFAULT FALSE,
        text_sent BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(),
        showed_up BOOLEAN DEFAULT NULL
      );
      CREATE TABLE IF NOT EXISTS followups (
        id SERIAL PRIMARY KEY, conversation_id INTEGER REFERENCES conversations(id),
        lead_handle TEXT NOT NULL, followup_type TEXT NOT NULL, message TEXT NOT NULL,
        status TEXT DEFAULT 'queued', queued_at TIMESTAMPTZ DEFAULT NOW(),
        sent_at TIMESTAMPTZ, dismissed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS insights_cache (
        id SERIAL PRIMARY KEY, generated_at TIMESTAMPTZ DEFAULT NOW(),
        insights JSONB NOT NULL, week_start DATE
      );
      CREATE TABLE IF NOT EXISTS kpi_data (
        id SERIAL PRIMARY KEY, user_id TEXT DEFAULT 'ian',
        view_type TEXT NOT NULL, period_label TEXT NOT NULL, period_index INTEGER NOT NULL,
        data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, view_type, period_label)
      );
    `);
    // Add new columns if they don't exist (for existing databases)
    await client.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_icp BOOLEAN DEFAULT FALSE;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS icp_flagged_at TIMESTAMPTZ;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS icp_pain_point BOOLEAN DEFAULT FALSE;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS icp_money BOOLEAN DEFAULT FALSE;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS icp_urgency BOOLEAN DEFAULT FALSE;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS show_rate TEXT DEFAULT NULL;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS showed_up BOOLEAN DEFAULT NULL;
    `);
    console.log('Database initialized');
  } catch (err) { console.error('DB init error:', err.message); }
  finally { client.release(); }
}
initDB();

function fmtInTZ(date, tz) {
  return new Date(date).toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short', timeZone:tz });
}

function buildFollowupMessage(type, leadHandle, situation) {
  const name = leadHandle.replace('@','').split('_')[0];
  const n = name.charAt(0).toUpperCase() + name.slice(1);
  const sit = situation || 'what you were working through';
  switch(type) {
    case '24h': return `hey ${n} just thinking about what you said about ${sit} had a thought on that`;
    case '48h': return `yo ${n} i posted something today that's literally exactly what we were talking about, check it out!`;
    case '72h': return `${n}! we could fix up your ${sit} pretty quick if you're open to it.`;
    case '2week': return `${n} random but did you end up doing anything about the ${sit} thing`;
    default: return `hey ${n} just checking in`;
  }
}

// ── ICP Auto-detection ────────────────────────────────────────────
// Runs after every lead message to check if they've hit all 3 ICP signals
async function checkICP(conversationId, allLeadMessages) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey || !allLeadMessages || allLeadMessages.length < 2) return;

  try {
    const combined = allLeadMessages.join(' ').substring(0, 1000);

    const prompt = `You are analyzing a DM conversation to detect if this person is a qualified lead (ICP) for Ian's communication coaching program.

The lead has said: "${combined}"

Score them on these 3 signals. Return ONLY valid JSON, nothing else:
{
  "pain_point": true/false (do they express a clear pain point around communication, confidence, social skills, rejection, relationships, networking, or awkwardness?),
  "money": true/false (do they show any indicator of ability to pay? e.g. has a job, career, business, mentions being in their 20s or older, talks about promotions, income, investing, work, profession),
  "urgency": true/false (do they show urgency or cost awareness? e.g. mentions what they're missing out on, frustration it's been a long time, fear of it getting worse, a specific goal or deadline, or they sound genuinely motivated to fix this),
  "is_icp": true/false (true only if ALL THREE above are true)
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
    });

    const data = await response.json();
    const raw = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);

    // Update conversation with ICP signals
    await pool.query(`
      UPDATE conversations SET
        icp_pain_point = $1,
        icp_money = $2,
        icp_urgency = $3,
        is_icp = $4,
        icp_flagged_at = CASE WHEN $4 = true AND is_icp = false THEN NOW() ELSE icp_flagged_at END,
        updated_at = NOW()
      WHERE id = $5
    `, [result.pain_point||false, result.money||false, result.urgency||false, result.is_icp||false, conversationId]);

    if (result.is_icp) console.log(`ICP flagged: conversation ${conversationId}`);
    return result;
  } catch (err) {
    console.error('ICP check error:', err.message);
    return null;
  }
}

// ── KPI auto-population: pull today's DM stats from DB ───────────
async function getAutoKPIStats(date) {
  // date format: 'Apr 3' or a date string
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE platform='instagram' OR platform='simulator') as ig_new_convos,
        COUNT(*) FILTER (WHERE platform='tiktok') as tt_new_convos,
        COUNT(*) FILTER (WHERE is_icp=true AND (platform='instagram' OR platform='simulator')) as ig_icp_leads,
        COUNT(*) FILTER (WHERE is_icp=true AND platform='tiktok') as tt_icp_leads,
        COUNT(*) FILTER (WHERE stage IN ('Pitch call','Schedule','Confirm','booked') AND (platform='instagram' OR platform='simulator')) as ig_calls_proposed,
        COUNT(*) FILTER (WHERE stage IN ('Pitch call','Schedule','Confirm','booked') AND platform='tiktok') as tt_calls_proposed,
        COUNT(*) FILTER (WHERE status='booked' AND (platform='instagram' OR platform='simulator')) as ig_calls_booked,
        COUNT(*) FILTER (WHERE status='booked' AND platform='tiktok') as tt_calls_booked
      FROM conversations
      WHERE created_at >= $1 AND created_at <= $2
    `, [startOfDay.toISOString(), endOfDay.toISOString()]);

    const fuStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='sent') as total_followups_sent
      FROM followups
      WHERE sent_at >= $1 AND sent_at <= $2
    `, [startOfDay.toISOString(), endOfDay.toISOString()]);

    const msgStats = await pool.query(`
      SELECT COUNT(*) as total_replies
      FROM messages
      WHERE role='lead' AND sent_at >= $1 AND sent_at <= $2
    `, [startOfDay.toISOString(), endOfDay.toISOString()]);

    return {
      ig_new_convos: parseInt(stats.rows[0].ig_new_convos)||0,
      tt_new_convos: parseInt(stats.rows[0].tt_new_convos)||0,
      ig_icp_leads: parseInt(stats.rows[0].ig_icp_leads)||0,
      tt_icp_leads: parseInt(stats.rows[0].tt_icp_leads)||0,
      ig_calls_proposed: parseInt(stats.rows[0].ig_calls_proposed)||0,
      tt_calls_proposed: parseInt(stats.rows[0].tt_calls_proposed)||0,
      ig_calls_booked: parseInt(stats.rows[0].ig_calls_booked)||0,
      tt_calls_booked: parseInt(stats.rows[0].tt_calls_booked)||0,
      ig_follow_ups: parseInt(fuStats.rows[0].total_followups_sent)||0,
      tt_follow_ups: 0,
      ig_replies: parseInt(msgStats.rows[0].total_replies)||0,
      tt_replies: 0,
    };
  } catch(err) {
    console.error('Auto KPI stats error:', err.message);
    return {};
  }
}

async function generateInsights() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return null;
  try {
    const convData = await pool.query(`
      SELECT c.id, c.status, c.stage, c.situation, c.is_icp, c.created_at, c.call_booked_at,
        EXTRACT(EPOCH FROM (c.call_booked_at - c.created_at))/3600 as hours_to_book,
        STRING_AGG(CASE WHEN m.role='lead' THEN m.content ELSE NULL END, ' | ' ORDER BY m.sent_at) as lead_messages
      FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id
      WHERE c.created_at > NOW() - INTERVAL '30 days'
      GROUP BY c.id ORDER BY c.created_at DESC LIMIT 50
    `);
    if (!convData.rows.length) return null;
    const summary = { total: convData.rows.length, booked: convData.rows.filter(r=>r.status==='booked').length, ghosted: convData.rows.filter(r=>r.status==='ghosted').length, icp: convData.rows.filter(r=>r.is_icp).length };
    const bookedConvs = convData.rows.filter(r=>r.status==='booked'&&r.lead_messages);
    const ghostedConvs = convData.rows.filter(r=>r.status==='ghosted'&&r.lead_messages);
    const prompt = `Analyzing DM data for Ian, 19yo entrepreneur coaching communication/confidence. Books strategy calls via IG/TikTok DMs.
Last 30 days: ${summary.total} conversations, ${summary.booked} booked, ${summary.ghosted} ghosted, ${summary.icp} ICP leads.
BOOKED: ${bookedConvs.slice(0,10).map(c=>`- "${c.situation}" | "${(c.lead_messages||'').substring(0,200)}"`).join('\n')}
GHOSTED: ${ghostedConvs.slice(0,10).map(c=>`- "${c.situation}" | "${(c.lead_messages||'').substring(0,200)}"`).join('\n')}
Return only valid JSON: {"conversion_rate":"X%","top_converting_situations":["s1","s2","s3"],"top_ghosting_situations":["s1","s2"],"winning_phrases":["p1","p2","p3"],"ghost_signals":["s1","s2"],"avg_hours_to_book":"X hours","fastest_close":"description","biggest_drop_stage":"stage","weekly_insight":"2 sentence insight, real talk no corporate speak","recommended_tweak":"1 sentence specific suggestion"}`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    const insights = JSON.parse((data.content?.[0]?.text||'{}').replace(/```json|```/g,'').trim());
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate()-weekStart.getDay());
    await pool.query(`INSERT INTO insights_cache (insights,week_start) VALUES ($1,$2)`, [JSON.stringify(insights), weekStart.toISOString().split('T')[0]]);
    return insights;
  } catch (err) { console.error('Insights error:', err.message); return null; }
}

async function sendWeeklyReport() {
  if (!app.locals.tokens) return;
  try {
    const stats = await pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='booked') as booked, COUNT(*) FILTER (WHERE status='ghosted') as ghosted, COUNT(*) FILTER (WHERE is_icp=true) as icp, COUNT(*) FILTER (WHERE stage IN ('pitch','schedule','confirm','booked')) as reached_pitch FROM conversations WHERE created_at > NOW() - INTERVAL '7 days'`);
    const s = stats.rows[0];
    const insightRow = await pool.query(`SELECT insights FROM insights_cache ORDER BY generated_at DESC LIMIT 1`);
    const insights = insightRow.rows.length > 0 ? insightRow.rows[0].insights : null;
    const weekStr = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:IAN_TZ});
    let body = `IAN.DM Weekly Report — ${weekStr}\n\nFUNNEL\nStarted: ${s.total}\nICP leads: ${s.icp}\nReached pitch: ${s.reached_pitch}\nBooked: ${s.booked}\nGhosted: ${s.ghosted}\nConversion: ${s.total>0?Math.round(s.booked/s.total*100):0}%\n`;
    if (insights) body += `\nINSIGHTS\n${insights.weekly_insight||''}\nRecommendation: ${insights.recommended_tweak||''}\n`;
    oauth2Client.setCredentials(app.locals.tokens);
    const gmail = google.gmail({version:'v1',auth:oauth2Client});
    const msg = [`To: ${IAN_EMAIL}`,`Subject: IAN.DM Weekly Report`,'Content-Type: text/plain; charset=utf-8','',body].join('\n');
    await gmail.users.messages.send({userId:'me',requestBody:{raw:Buffer.from(msg).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}});
  } catch (err) { console.error('Weekly report error:', err.message); }
}

async function runFollowupCron() {
  try {
    const result = await pool.query(`SELECT c.id, c.lead_handle, c.situation, c.stage, MAX(m.sent_at) as last_message_at, COUNT(f.id) FILTER (WHERE f.status!='dismissed') as followup_count, MAX(f.followup_type) as last_followup_type FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id LEFT JOIN followups f ON f.conversation_id=c.id WHERE c.status='active' AND c.stage!='booked' GROUP BY c.id`);
    const now = new Date();
    for (const conv of result.rows) {
      if (!conv.last_message_at) continue;
      const h = (now - new Date(conv.last_message_at)) / (1000*60*60);
      const fc = parseInt(conv.followup_count)||0, lt = conv.last_followup_type;
      let ft = null;
      if (h>=24&&h<48&&fc===0) ft='24h';
      else if (h>=48&&h<72&&lt==='24h') ft='48h';
      else if (h>=72&&h<336&&lt==='48h') ft='72h';
      else if (h>=336&&lt==='72h') ft='2week';
      else if (h>=500&&lt==='2week') { await pool.query(`UPDATE conversations SET status='ghosted',ghosted_at=NOW(),updated_at=NOW() WHERE id=$1`,[conv.id]); continue; }
      if (ft) {
        const ex = await pool.query(`SELECT id FROM followups WHERE conversation_id=$1 AND followup_type=$2`,[conv.id,ft]);
        if (!ex.rows.length) await pool.query(`INSERT INTO followups (conversation_id,lead_handle,followup_type,message) VALUES ($1,$2,$3,$4)`,[conv.id,conv.lead_handle,ft,buildFollowupMessage(ft,conv.lead_handle,conv.situation)]);
      }
    }
  } catch (err) { console.error('Cron error:', err.message); }
}

setInterval(runFollowupCron, 60*60*1000);
setTimeout(runFollowupCron, 10000);

function scheduleWeeklyReport() {
  const pst = new Date(new Date().toLocaleString('en-US',{timeZone:IAN_TZ}));
  const daysUntil = (8-pst.getDay())%7||7;
  const next = new Date(pst); next.setDate(pst.getDate()+daysUntil); next.setHours(8,0,0,0);
  setTimeout(()=>{ generateInsights().then(()=>sendWeeklyReport()); setInterval(()=>generateInsights().then(()=>sendWeeklyReport()),7*24*60*60*1000); }, next-pst);
}
scheduleWeeklyReport();

const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.REDIRECT_URI);

app.get('/auth/google', (req,res) => {
  res.redirect(oauth2Client.generateAuthUrl({ access_type:'offline', prompt:'consent', scope:['https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/calendar.events','https://www.googleapis.com/auth/gmail.send'] }));
});
app.get('/auth/callback', async (req,res) => {
  const { tokens } = await oauth2Client.getToken(req.query.code);
  oauth2Client.setCredentials(tokens); app.locals.tokens = tokens;
  res.send(`<h2 style="font-family:sans-serif;padding:40px">Connected to Google Calendar + Gmail. You can close this tab.</h2>`);
});

app.get('/now', (req,res) => {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US',{timeZone:IAN_TZ,year:'numeric',month:'2-digit',day:'2-digit',weekday:'long',hour:'numeric',minute:'2-digit',hour12:true});
  const parts = fmt.formatToParts(now);
  const get = type => parts.find(p=>p.type===type)?.value||'';
  const year=parseInt(get('year')),month=parseInt(get('month')),day=parseInt(get('day'));
  const todayStr=`${get('weekday')}, ${get('month')}/${day}/${year} at ${get('hour')}:${get('minute')} ${get('dayPeriod')} PST`;
  const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const nextDays=[];
  for(let i=0;i<=7;i++){
    const d=new Date(now); d.setUTCHours(d.getUTCHours()+i*24);
    const dp=new Intl.DateTimeFormat('en-US',{timeZone:IAN_TZ,year:'numeric',month:'2-digit',day:'2-digit',weekday:'long'}).formatToParts(d);
    const dget=type=>dp.find(p=>p.type===type)?.value||'';
    const pad=n=>String(n).padStart(2,'0');
    const dY=parseInt(dget('year')),dM=parseInt(dget('month')),dD=parseInt(dget('day'));
    nextDays.push({label:i===0?'today':i===1?'tomorrow':dget('weekday'),weekday:dget('weekday'),date:`${dY}-${pad(dM)}-${pad(dD)}`,display:`${dget('weekday')} ${MONTHS[dM-1]} ${dD}`});
  }
  res.json({now:todayStr,today:{year,month,day,weekday:get('weekday')},nextDays,iso:now.toISOString()});
});

app.get('/availability', async (req,res) => {
  if(!app.locals.tokens) return res.json({availability:'Not connected to Google Calendar yet.'});
  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const calendar=google.calendar({version:'v3',auth:oauth2Client});
    const now=new Date(), weekOut=new Date(now.getTime()+7*24*60*60*1000);
    const eventsRes=await calendar.events.list({calendarId:'primary',timeMin:now.toISOString(),timeMax:weekOut.toISOString(),singleEvents:true,orderBy:'startTime'});
    const events=eventsRes.data.items||[];
    if(!events.length) return res.json({availability:'Calendar is open for the next 7 days.'});
    res.json({availability:events.map(e=>`${e.summary||'Busy'}: ${fmtInTZ(e.start.dateTime||e.start.date,IAN_TZ)} to ${new Date(e.end.dateTime||e.end.date).toLocaleString('en-US',{hour:'numeric',minute:'2-digit',timeZone:IAN_TZ})}`).join('\n')});
  } catch(err){res.json({availability:'Error: '+err.message});}
});

// ── Conversation tracking ─────────────────────────────────────────
app.post('/conversation/start', async (req,res) => {
  const {leadHandle,platform}=req.body;
  try {
    const ex=await pool.query(`SELECT id FROM conversations WHERE lead_handle=$1 AND status='active' ORDER BY created_at DESC LIMIT 1`,[leadHandle]);
    if(ex.rows.length) return res.json({conversationId:ex.rows[0].id,resumed:true});
    const r=await pool.query(`INSERT INTO conversations (lead_handle,platform,stage,status) VALUES ($1,$2,'opened','active') RETURNING id`,[leadHandle,platform||'simulator']);
    res.json({conversationId:r.rows[0].id,resumed:false});
  } catch(err){res.status(500).json({error:err.message});}
});

app.post('/conversation/message', async (req,res) => {
  const {conversationId,role,content,stage}=req.body;
  try {
    await pool.query(`INSERT INTO messages (conversation_id,role,content,stage_at_time) VALUES ($1,$2,$3,$4)`,[conversationId,role,content,stage]);

    // Run ICP check after every lead message
    if (role === 'lead' && conversationId) {
      const allMsgs = await pool.query(`SELECT content FROM messages WHERE conversation_id=$1 AND role='lead' ORDER BY sent_at ASC`,[conversationId]);
      const leadMessages = allMsgs.rows.map(r=>r.content);
      checkICP(conversationId, leadMessages); // async, don't await
    }

    res.json({success:true});
  } catch(err){res.status(500).json({error:err.message});}
});

app.post('/conversation/stage', async (req,res) => {
  const {conversationId,fromStage,toStage}=req.body;
  try {
    await pool.query(`UPDATE conversations SET stage=$1,updated_at=NOW() WHERE id=$2`,[toStage,conversationId]);
    await pool.query(`INSERT INTO stage_transitions (conversation_id,from_stage,to_stage) VALUES ($1,$2,$3)`,[conversationId,fromStage,toStage]);
    res.json({success:true});
  } catch(err){res.status(500).json({error:err.message});}
});

app.post('/conversation/status', async (req,res) => {
  const {conversationId,status}=req.body;
  try {
    const tsF=status==='ghosted'?'ghosted_at':status==='declined'?'declined_at':null;
    if(tsF) await pool.query(`UPDATE conversations SET status=$1,${tsF}=NOW(),updated_at=NOW() WHERE id=$2`,[status,conversationId]);
    else await pool.query(`UPDATE conversations SET status=$1,updated_at=NOW() WHERE id=$2`,[status,conversationId]);
    res.json({success:true});
  } catch(err){res.status(500).json({error:err.message});}
});

// ── Show rate tracking ────────────────────────────────────────────
app.post('/bookings/:id/showed', async (req,res) => {
  const {showed} = req.body; // true or false
  try {
    await pool.query(`UPDATE bookings SET showed_up=$1 WHERE id=$2`,[showed,req.params.id]);
    // Also update conversation
    await pool.query(`UPDATE conversations SET show_rate=$1, updated_at=NOW() WHERE id=(SELECT conversation_id FROM bookings WHERE id=$2)`,[showed?'showed':'no-show',req.params.id]);
    res.json({success:true});
  } catch(err){res.status(500).json({error:err.message});}
});

// ── KPI auto-population ───────────────────────────────────────────
app.get('/kpi/auto', async (req,res) => {
  try {
    const stats = await getAutoKPIStats();
    res.json({success:true, stats});
  } catch(err){res.status(500).json({error:err.message});}
});

// ── KPI endpoints ─────────────────────────────────────────────────
app.get('/kpi', async (req,res) => {
  try {
    const result=await pool.query(`SELECT view_type,period_label,period_index,data FROM kpi_data WHERE user_id='ian' ORDER BY view_type,period_index ASC`);
    const W={daily:[],weekly:[],monthly:[],yearly:[]};
    result.rows.forEach(row=>{if(W[row.view_type])W[row.view_type].push({label:row.period_label,...row.data});});
    res.json({data:W,hasData:Object.values(W).some(arr=>arr.length>0)});
  } catch(err){res.status(500).json({error:err.message});}
});

app.post('/kpi', async (req,res) => {
  const {viewType,periodLabel,periodIndex,data}=req.body;
  try {
    await pool.query(`INSERT INTO kpi_data (user_id,view_type,period_label,period_index,data,updated_at) VALUES ('ian',$1,$2,$3,$4,NOW()) ON CONFLICT (user_id,view_type,period_label) DO UPDATE SET data=$4,period_index=$3,updated_at=NOW()`,[viewType,periodLabel,periodIndex,JSON.stringify(data)]);
    res.json({success:true});
  } catch(err){res.status(500).json({error:err.message});}
});

app.post('/kpi/bulk', async (req,res) => {
  const {W}=req.body;
  try {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      for(const viewType of ['daily','weekly','monthly','yearly']){
        const periods=W[viewType]||[];
        for(let i=0;i<periods.length;i++){
          const {label,...data}=periods[i];
          await client.query(`INSERT INTO kpi_data (user_id,view_type,period_label,period_index,data,updated_at) VALUES ('ian',$1,$2,$3,$4,NOW()) ON CONFLICT (user_id,view_type,period_label) DO UPDATE SET data=$4,period_index=$3,updated_at=NOW()`,[viewType,label,i,JSON.stringify(data)]);
        }
      }
      await client.query('COMMIT');
      res.json({success:true});
    } catch(err){await client.query('ROLLBACK');throw err;}
    finally{client.release();}
  } catch(err){res.status(500).json({error:err.message});}
});

app.delete('/kpi', async (req,res) => {
  const {viewType,periodLabel}=req.body;
  try {
    await pool.query(`DELETE FROM kpi_data WHERE user_id='ian' AND view_type=$1 AND period_label=$2`,[viewType,periodLabel]);
    res.json({success:true});
  } catch(err){res.status(500).json({error:err.message});}
});

// ── Follow-ups ────────────────────────────────────────────────────
app.get('/followups', async (req,res) => {
  try { const r=await pool.query(`SELECT f.*,c.stage FROM followups f JOIN conversations c ON c.id=f.conversation_id WHERE f.status='queued' ORDER BY f.queued_at ASC`); res.json({followups:r.rows}); }
  catch(err){res.status(500).json({error:err.message});}
});
app.post('/followups/:id/sent', async (req,res) => {
  try { await pool.query(`UPDATE followups SET status='sent',sent_at=NOW() WHERE id=$1`,[req.params.id]); res.json({success:true}); }
  catch(err){res.status(500).json({error:err.message});}
});
app.post('/followups/:id/dismiss', async (req,res) => {
  try { await pool.query(`UPDATE followups SET status='dismissed',dismissed_at=NOW() WHERE id=$1`,[req.params.id]); res.json({success:true}); }
  catch(err){res.status(500).json({error:err.message});}
});
app.post('/followups/run', async (req,res) => { await runFollowupCron(); res.json({success:true}); });

// ── Analytics ─────────────────────────────────────────────────────
app.get('/analytics/stats', async (req,res) => {
  try {
    const stats=await pool.query(`SELECT COUNT(*) FILTER (WHERE status!='test') as total_conversations, COUNT(*) FILTER (WHERE is_icp=true) as icp_leads, COUNT(*) FILTER (WHERE stage IN ('Pitch call','Schedule','Confirm','booked')) as reached_pitch, COUNT(*) FILTER (WHERE status='booked') as calls_booked, COUNT(*) FILTER (WHERE status='ghosted') as ghosted, COUNT(*) FILTER (WHERE status='declined') as declined, COUNT(*) FILTER (WHERE show_rate='showed') as showed_up, COUNT(*) FILTER (WHERE show_rate='no-show') as no_showed, ROUND(AVG(EXTRACT(EPOCH FROM (call_booked_at-created_at))/3600) FILTER (WHERE call_booked_at IS NOT NULL),1) as avg_hours_to_book FROM conversations`);
    const dropoffs=await pool.query(`SELECT stage,COUNT(*) as count FROM conversations WHERE status IN ('active','ghosted') GROUP BY stage ORDER BY count DESC`);
    const recentBookings=await pool.query(`SELECT b.*,c.is_icp FROM bookings b LEFT JOIN conversations c ON c.id=b.conversation_id ORDER BY b.created_at DESC LIMIT 10`);
    const stageFunnel=await pool.query(`SELECT to_stage as stage,COUNT(*) as count FROM stage_transitions GROUP BY to_stage ORDER BY count DESC`);
    const weekly=await pool.query(`SELECT DATE_TRUNC('week',created_at) as week, COUNT(*) as started, COUNT(*) FILTER (WHERE status='booked') as booked, COUNT(*) FILTER (WHERE status='ghosted') as ghosted, COUNT(*) FILTER (WHERE is_icp=true) as icp FROM conversations GROUP BY week ORDER BY week DESC LIMIT 8`);
    const insightRow=await pool.query(`SELECT insights FROM insights_cache ORDER BY generated_at DESC LIMIT 1`);
    res.json({summary:stats.rows[0],dropoffs:dropoffs.rows,recentBookings:recentBookings.rows,stageFunnel:stageFunnel.rows,weekly:weekly.rows,insights:insightRow.rows.length>0?insightRow.rows[0].insights:null});
  } catch(err){res.status(500).json({error:err.message});}
});

app.post('/analytics/generate-insights', async (req,res) => {
  const insights=await generateInsights();
  if(insights) res.json({success:true,insights});
  else res.json({success:false,message:'Not enough data yet'});
});
app.post('/analytics/send-report', async (req,res) => { await generateInsights(); await sendWeeklyReport(); res.json({success:true}); });

app.get('/conversations', async (req,res) => {
  try {
    const r=await pool.query(`SELECT c.*,COUNT(m.id) as message_count,COUNT(f.id) FILTER (WHERE f.status='queued') as pending_followups FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id LEFT JOIN followups f ON f.conversation_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 100`);
    res.json({conversations:r.rows});
  } catch(err){res.status(500).json({error:err.message});}
});

app.get('/conversations/:id', async (req,res) => {
  try {
    const conv=await pool.query(`SELECT * FROM conversations WHERE id=$1`,[req.params.id]);
    const messages=await pool.query(`SELECT * FROM messages WHERE conversation_id=$1 ORDER BY sent_at ASC`,[req.params.id]);
    const transitions=await pool.query(`SELECT * FROM stage_transitions WHERE conversation_id=$1 ORDER BY transitioned_at ASC`,[req.params.id]);
    const followups=await pool.query(`SELECT * FROM followups WHERE conversation_id=$1 ORDER BY queued_at ASC`,[req.params.id]);
    res.json({conversation:conv.rows[0],messages:messages.rows,transitions:transitions.rows,followups:followups.rows});
  } catch(err){res.status(500).json({error:err.message});}
});

// ── Book ──────────────────────────────────────────────────────────
app.post('/book', async (req,res) => {
  const {leadName,dateTime,timezone,durationMinutes,situation,conversationId}=req.body;
  if(!app.locals.tokens) return res.status(400).json({error:'Not connected to Google Calendar.'});
  try {
    oauth2Client.setCredentials(app.locals.tokens);
    const calendar=google.calendar({version:'v3',auth:oauth2Client});
    const tz=timezone||IAN_TZ;
    const localStr=dateTime.includes('T')?dateTime:dateTime.replace(' ','T');
    const [datePart,timePart]=localStr.split('T');
    const [year,month,day]=datePart.split('-').map(Number);
    const [hour,minute,sec]=(timePart||'00:00:00').split(':').map(Number);
    const probe=new Date(`${datePart}T${timePart||'12:00:00'}Z`);
    const offsetMs=new Date(probe.toLocaleString('en-US',{timeZone:'UTC',hour12:false}))-new Date(probe.toLocaleString('en-US',{timeZone:tz,hour12:false}));
    const startDate=new Date(Date.UTC(year,month-1,day,hour,minute,sec||0)+offsetMs);
    const endDate=new Date(startDate.getTime()+(durationMinutes||30)*60*1000);
    const startFormatted=fmtInTZ(startDate,IAN_TZ);
    const event=await calendar.events.insert({calendarId:'primary',requestBody:{summary:`Strategy Call w/ ${leadName}`,description:`Situation: ${situation}\nLead timezone: ${tz}\nBooked via IAN.DM`,start:{dateTime:startDate.toISOString(),timeZone:'UTC'},end:{dateTime:endDate.toISOString(),timeZone:'UTC'}}});
    let bookingId=null;
    try {
      const bR=await pool.query(`INSERT INTO bookings (conversation_id,lead_handle,call_datetime,timezone,situation,calendar_event_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,[conversationId||null,leadName,startDate.toISOString(),tz,situation,event.data.id]);
      bookingId=bR.rows[0].id;
      if(conversationId){
        await pool.query(`UPDATE conversations SET stage='booked',status='booked',call_booked_at=NOW(),call_datetime=$1,situation=$2,updated_at=NOW() WHERE id=$3`,[startDate.toISOString(),situation,conversationId]);
        await pool.query(`INSERT INTO stage_transitions (conversation_id,from_stage,to_stage) VALUES ($1,'confirm','booked')`,[conversationId]);
        await pool.query(`UPDATE followups SET status='dismissed',dismissed_at=NOW() WHERE conversation_id=$1 AND status='queued'`,[conversationId]);
      }
    } catch(dbErr){console.error('DB booking error:',dbErr.message);}
    let emailSent=false;
    try {
      const gmail=google.gmail({version:'v1',auth:oauth2Client});
      const body=`New strategy call booked\n\nLead: ${leadName}\nTime: ${startFormatted}\nSituation: ${situation}\n\nCalendar: ${event.data.htmlLink}`;
      const msg=[`To: ${IAN_EMAIL}`,`Subject: IAN.DM: Call booked with ${leadName}`,'Content-Type: text/plain; charset=utf-8','',body].join('\n');
      await gmail.users.messages.send({userId:'me',requestBody:{raw:Buffer.from(msg).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}});
      emailSent=true;
    } catch(gmailErr){console.error('Gmail error:',gmailErr.message);}
    const {TWILIO_ACCOUNT_SID:tSid,TWILIO_AUTH_TOKEN:tAuth,TWILIO_FROM:tFrom,MY_PHONE_NUMBER:tTo}=process.env;
    let textSent=false,twilioError=null;
    if(tSid&&tAuth&&tFrom&&tTo){
      const tRes=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tSid}/Messages.json`,{method:'POST',headers:{'Authorization':'Basic '+Buffer.from(`${tSid}:${tAuth}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({From:tFrom,To:tTo,Body:`IAN.DM: call booked\nLead: ${leadName}\nTime: ${startFormatted}\nSituation: ${situation}`})});
      const tData=await tRes.json(); textSent=tRes.ok&&!tData.error_code;
      if(!textSent) twilioError=`${tData.error_code}: ${tData.message}`;
    }
    res.json({success:true,eventId:event.data.id,startFormatted,emailSent,textSent,twilioError,bookingId});
  } catch(err){console.error('Book error:',err.message);res.status(500).json({error:err.message});}
});

app.post('/chat', async (req,res) => {
  const {messages,system}=req.body;
  try {
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:380,system,messages})});
    res.json(await r.json());
  } catch(err){res.status(500).json({error:{message:err.message}});}
});

app.get('/health', (_,res) => res.json({status:'ok'}));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
