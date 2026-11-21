const nodemailer = require('nodemailer');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const BOT_FROM = process.env.BOT_FROM || 'UfficioCal Bot <onboarding@resend.dev>';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let state = {
  users: [],
  events: [],
  sentEmails: []
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readDiskState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { users: [], events: [], sentEmails: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      users: Array.isArray(raw.users) ? raw.users : [],
      events: Array.isArray(raw.events) ? raw.events : [],
      sentEmails: Array.isArray(raw.sentEmails) ? raw.sentEmails : []
    };
  } catch {
    return { users: [], events: [], sentEmails: [] };
  }
}

function mergeEvents(existingEvents, incomingEvents) {
  const map = new Map();
  (Array.isArray(existingEvents) ? existingEvents : []).forEach(ev => {
    if (ev && ev.id) map.set(ev.id, ev);
  });
  (Array.isArray(incomingEvents) ? incomingEvents : []).forEach(ev => {
    if (!ev || !ev.id) return;
    const prev = map.get(ev.id);
    if (prev && Array.isArray(prev.alerts) && Array.isArray(ev.alerts)) {
      const mergedAlerts = ev.alerts.map((al, idx) => {
        const oldAl = prev.alerts.find(o => o && (o.sendAt === al.sendAt || o.index === al.index)) || prev.alerts[idx];
        if (oldAl && oldAl.sent) {
          return { ...al, sent: true, sentAt: oldAl.sentAt || al.sentAt };
        }
        return al;
      });
      map.set(ev.id, { ...prev, ...ev, alerts: mergedAlerts });
    } else {
      map.set(ev.id, ev);
    }
  });
  return Array.from(map.values());
}

function saveStateLocalOnly() {
  ensureDataDir();
  const disk = readDiskState();

  const mergedUsersMap = new Map();
  [...disk.users, ...(state.users || [])].forEach(u => {
    if (u && u.email) {
      const em = String(u.email).trim().toLowerCase();
      const prev = mergedUsersMap.get(em) || {};
      mergedUsersMap.set(em, { ...prev, ...u, email: em });
    }
  });

  const mergedEvents = mergeEvents(disk.events, state.events);

  const mailMap = new Map();
  [...(state.sentEmails || []), ...disk.sentEmails].forEach(m => {
    if (m && m.id) mailMap.set(m.id, m);
  });
  const mergedMails = Array.from(mailMap.values())
    .sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))
    .slice(0, 200);

  state = {
    users: Array.from(mergedUsersMap.values()),
    events: mergedEvents,
    sentEmails: mergedMails
  };

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function deriveName(email) {
  const local = String(email || '').split('@')[0] || 'Utente';
  const cleaned = local.replace(/[0-9._-]+/g, ' ').trim() || local;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function upsertUser(email, name) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) return null;

  state.users = Array.isArray(state.users) ? state.users : [];
  const nowIso = new Date().toISOString();
  const existing = state.users.find(u => String(u.email || '').toLowerCase() === cleanEmail);

  if (existing) {
    existing.name = (name && String(name).trim()) || existing.name || deriveName(cleanEmail);
    existing.lastSeen = nowIso;
    return existing;
  }

  const created = {
    id: 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    email: cleanEmail,
    name: (name && String(name).trim()) || deriveName(cleanEmail),
    createdAt: nowIso,
    lastSeen: nowIso
  };
  state.users.push(created);
  return created;
}

function loadState() {
  ensureDataDir();
  state = readDiskState();
  saveState();
}

function colorName(hex) {
  const map = {
    '#3b82f6': 'Blu',
    '#10b981': 'Verde',
    '#f59e0b': 'Ambra',
    '#ef4444': 'Rosso',
    '#8b5cf6': 'Viola'
  };
  return map[(hex || '').toLowerCase()] || hex || 'Blu';
}

function recordSentEmail(entry) {
  state.sentEmails = Array.isArray(state.sentEmails) ? state.sentEmails : [];
  state.sentEmails.unshift({
    id: 'mail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    to: entry.to || '',
    subject: entry.subject || 'Notifica UfficioCal',
    eventTitle: entry.eventTitle || '',
    color: entry.color || '',
    source: entry.source || 'bot',
    provider: 'resend',
    status: entry.status || 'inviata',
    error: entry.error || '',
    sentAt: new Date().toISOString()
  });
  state.sentEmails = state.sentEmails.slice(0, 200);
}
const GMAIL_USER = (process.env.GMAIL_USER || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

const gmailTransporter = (GMAIL_USER && GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD
      }
    })
  : null;

async function dispatchResendEmail({ to, subject, html, eventTitle, color, source }) {
  const recipients = Array.isArray(to)
    ? Array.from(new Set(to.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)))
    : String(to || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

  if (!recipients.length) {
    throw new Error('Nessun destinatario valido');
  }
  if (!gmailTransporter) {
    throw new Error('Configura GMAIL_USER e GMAIL_APP_PASSWORD nelle Environment Variables');
  }

  const info = await gmailTransporter.sendMail({
    from: `"UfficioCal Bot" <${GMAIL_USER}>`,
    to: recipients.join(', '),
    subject: subject || `Avviso UfficioCal: ${eventTitle || 'Impegno'}`,
    html: html || `<p>Notifica per l'impegno <strong>${eventTitle || 'Impegno'}</strong>.</p>`
  });

  const record = {
    id: 'mail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    to: recipients,
    subject: subject || `Avviso UfficioCal: ${eventTitle || 'Impegno'}`,
    eventTitle: eventTitle || 'Impegno',
    color: color || '#3b82f6',
    source: source || 'bot-alert',
    sentAt: new Date().toISOString(),
    messageId: info.messageId || null
  };

  state.sentEmails = [record, ...(state.sentEmails || [])].slice(0, 200);
  saveState();
  return record;
}

app.post('/api/register-user', (req, res) => {
  const { email, name } = req.body || {};
  const user = upsertUser(email, name);
  if (!user) {
    return res.status(400).json({ ok: false, error: 'Email non valida' });
  }
  saveState();
  res.json({ ok: true, user, users: state.users });
});

app.delete('/api/events/:id', (req, res) => {
  const id = String(req.params.id || '');
  state.deletedEventIds = Array.from(new Set([...(state.deletedEventIds || []), id]));
  state.events = (state.events || []).filter(e => String(e.id) !== id);
  saveState();
  res.json({ ok: true, events: state.events });
});

app.get('/api/state', (req, res) => {
  res.json(state);
});

app.post('/api/state', (req, res) => {
  const { users, events, sentEmails, activeUser } = req.body || {};
  if (activeUser && activeUser.email) {
    upsertUser(activeUser.email, activeUser.name);
  }
  if (Array.isArray(users)) {
    users.forEach(u => {
      if (u && u.email) upsertUser(u.email, u.name);
    });
  }
  if (Array.isArray(events) && events.length > 0) {
    const delSet = new Set((state.deletedEventIds || []).map(String)); state.events = mergeEvents(state.events, events).filter(e => !delSet.has(String(e.id)));
  }
  if (Array.isArray(sentEmails) && sentEmails.length > 0) {
    state.sentEmails = [...sentEmails, ...(state.sentEmails || [])];
  }
  saveState();
  res.json({ ok: true, state });
});

app.post('/api/send-email', async (req, res) => {
  const { to, subject, html, eventTitle, color, source } = req.body || {};
  try {
    const result = await dispatchResendEmail({
      to,
      subject: subject || `Avviso UfficioCal: ${eventTitle || 'Impegno'}`,
      html: html || `<p>Notifica per l'impegno <strong>${eventTitle || 'Impegno'}</strong>.</p>`,
      eventTitle,
      color,
      source: source || 'manual'
    });
    res.json({ ok: true, result, sentEmails: state.sentEmails });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err), sentEmails: state.sentEmails });
  }
});

app.post('/api/ai', async (req, res) => {
  const { prompt, systemInstruction } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt mancante' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        temperature: 0.5,
        max_tokens: 600,
        messages: [
          ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
          { role: 'user', content: prompt }
        ]
      })
    });
    clearTimeout(timer);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return res.status(resp.status).json({ error: data?.error?.message || `Groq HTTP ${resp.status}` });
    }
    const text = data?.choices?.[0]?.message?.content?.trim();
    return res.json({ reply: text || 'Risposta vuota da Groq.' });
  } catch (err) {
    clearTimeout(timer);
    return res.status(504).json({ error: err?.name === 'AbortError' ? 'Timeout Groq' : (err?.message || String(err)) });
  }
});

async function processScheduledAlerts() {
  const nowMs = Date.now();
  let changed = false;

  for (const ev of state.events || []) {
    const alerts = Array.isArray(ev.alerts) ? ev.alerts : [];
    for (let idx = 0; idx < alerts.length; idx++) {
      const al = alerts[idx];
      if (!al || al.sent) continue;

      const rawTime = al.sendAt || al.dateTime || al.at;
      const targetMs = rawTime ? new Date(rawTime).getTime() : NaN;
      if (Number.isNaN(targetMs) || targetMs > nowMs) continue;

      const allRegistered = (state.users || []).map(u => String(u.email || '').toLowerCase()).filter(Boolean);
      const recipients = ev.recipientMode === 'selected'
        ? (Array.isArray(al.emails) && al.emails.length ? al.emails : (Array.isArray(ev.emails) ? ev.emails : []))
        : Array.from(new Set([...allRegistered, ...(Array.isArray(ev.emails) ? ev.emails : []), ...(Array.isArray(al.emails) ? al.emails : [])]));

      if (!recipients.length) continue;

      const cName = colorName(ev.color);
      const subject = `Alert #${idx + 1} UfficioCal — ${ev.title || 'Impegno'}`;
      const html = `
        <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#0f172a;">
          <h2 style="margin-bottom:8px;">Alert #${idx + 1} — ${ev.title || 'Impegno'}</h2>
          <p><strong>Colore:</strong> <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${ev.color || '#3b82f6'};vertical-align:middle;"></span> ${cName} (${ev.color || '#3b82f6'})</p>
          <p><strong>Data impegno:</strong> ${ev.date || '-'}</p>
          <p><strong>Orario:</strong> ${ev.startTime || '--:--'} - ${ev.endTime || '--:--'}</p>
          <p><strong>Data/ora alert impostata:</strong> ${new Date(targetMs).toLocaleString('it-IT')}</p>
        </div>
      `;

      try {
        await dispatchResendEmail({
          to: recipients,
          subject,
          html,
          eventTitle: ev.title || 'Impegno',
          color: ev.color || '#3b82f6',
          source: 'bot-alert'
        });
        al.sent = true;
        al.sentAt = new Date().toISOString();
        changed = true;
      } catch (err) {
        al.lastError = err?.message || String(err);
        changed = true;
      }
    }
  }

  if (changed) {
    saveState();
  }
}

function saveState() {
  saveStateLocalOnly();
  syncStateToCloud();
}

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const CLOUD_STATE_KEY = 'ufficiocal:state:v1';

async function syncStateToCloud() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    const keyPart = encodeURIComponent(CLOUD_STATE_KEY);
    await fetch(`${UPSTASH_URL}/set/${keyPart}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(state)
    });
  } catch (err) {
    console.error('Errore salvataggio cloud:', err?.message || err);
  }
}

async function restoreStateFromCloud() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  try {
    const keyPart = encodeURIComponent(CLOUD_STATE_KEY);
    const resp = await fetch(`${UPSTASH_URL}/get/${keyPart}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await resp.json().catch(() => ({}));
    if (data && typeof data.result === 'string' && data.result.trim()) {
      const parsed = JSON.parse(data.result);
      if (parsed && typeof parsed === 'object') {
        state = {
          users: Array.isArray(parsed.users) ? parsed.users : [],
          events: Array.isArray(parsed.events) ? parsed.events : [],
          sentEmails: Array.isArray(parsed.sentEmails) ? parsed.sentEmails : [],
          deletedEventIds: Array.isArray(parsed.deletedEventIds) ? parsed.deletedEventIds : []
        };
        saveStateLocalOnly();
        console.log('Stato ripristinato dal cloud (impegni:', state.events.length, ')');
        return true;
      }
    }
  } catch (err) {
    console.error('Errore ripristino cloud:', err?.message || err);
  }
  return false;
}

loadState();
restoreStateFromCloud().then(() => processScheduledAlerts());
setInterval(processScheduledAlerts, 30000);
setTimeout(processScheduledAlerts, 4000);

app.listen(PORT, () => {
  console.log(`UfficioCal server attivo su http://localhost:${PORT}`);
});