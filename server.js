const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_URL || '').trim().replace(/\/+$/, '');
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_TOKEN || '').trim();
const CLOUD_KEY = 'ufficiocal:state:v1';

const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();
const GMAIL_USER = (process.env.GMAIL_USER || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

const gmailTransporter = (GMAIL_USER && GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
    })
  : null;

let state = {
  users: [],
  events: [],
  sentEmails: [],
  deletedEventIds: []
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function purgeDeletedEvents() {
  if (!Array.isArray(state.events)) state.events = [];
  if (!Array.isArray(state.deletedEventIds)) state.deletedEventIds = [];
  const delSet = new Set(state.deletedEventIds.map(x => String(x || '').trim()).filter(Boolean));
  if (delSet.size > 0) {
    state.events = state.events.filter(ev => {
      const id = String((ev && (ev.id ?? ev._id)) ?? '').trim();
      return !id || !delSet.has(id);
    });
  }
}

function upsertUser(email, name) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) return;
  const cleanName = String(name || '').trim() || cleanEmail.split('@')[0];
  if (!Array.isArray(state.users)) state.users = [];
  const idx = state.users.findIndex(u => String(u.email || '').toLowerCase() === cleanEmail);
  if (idx >= 0) {
    state.users[idx] = { ...state.users[idx], email: cleanEmail, name: cleanName };
  } else {
    state.users.push({ email: cleanEmail, name: cleanName });
  }
}

function saveLocal() {
  purgeDeletedEvents();
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function loadLocal() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        state = {
          users: Array.isArray(raw.users) ? raw.users : [],
          events: Array.isArray(raw.events) ? raw.events : [],
          sentEmails: Array.isArray(raw.sentEmails) ? raw.sentEmails : [],
          deletedEventIds: Array.isArray(raw.deletedEventIds) ? raw.deletedEventIds : []
        };
        purgeDeletedEvents();
      }
    }
  } catch (err) {
    console.error('Errore lettura disco:', err.message);
  }
}

async function syncToCloud() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  purgeDeletedEvents();
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(CLOUD_KEY)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(state)
    });
  } catch (err) {
    console.error('Errore sync Upstash:', err.message);
  }
}

async function restoreFromCloud() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    const resp = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(CLOUD_KEY)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await resp.json().catch(() => ({}));
    if (data && typeof data.result === 'string' && data.result.trim()) {
      const parsed = JSON.parse(data.result);
      if (parsed && typeof parsed === 'object') {
        state = {
          users: Array.isArray(parsed.users) ? parsed.users : state.users,
          events: Array.isArray(parsed.events) ? parsed.events : state.events,
          sentEmails: Array.isArray(parsed.sentEmails) ? parsed.sentEmails : state.sentEmails,
          deletedEventIds: Array.isArray(parsed.deletedEventIds) ? parsed.deletedEventIds : state.deletedEventIds
        };
        purgeDeletedEvents();
        saveLocal();
      }
    }
  } catch (err) {
    console.error('Errore restore Upstash:', err.message);
  }
}

function persistAll() {
  saveLocal();
  Promise.resolve().then(() => syncToCloud()).catch(() => {});
}

function getAllRegisteredEmails() {
  return Array.from(new Set(
    (state.users || [])
      .map(u => String((u && u.email) || '').trim().toLowerCase())
      .filter(e => e.includes('@'))
  ));
}

function resolveRecipients(evOrObj) {
  const mode = evOrObj && evOrObj.recipientMode === 'selected' ? 'selected' : 'all';
  const explicit = Array.isArray(evOrObj && evOrObj.emails)
    ? evOrObj.emails.map(x => String(x || '').trim().toLowerCase()).filter(e => e.includes('@'))
    : [];
  if (mode === 'all') {
    return Array.from(new Set([...getAllRegisteredEmails(), ...explicit]));
  }
  return Array.from(new Set(explicit));
}

async function sendMailNow({ to, subject, html, text, eventTitle }) {
  const recipients = Array.isArray(to)
    ? Array.from(new Set(to.map(x => String(x || '').trim().toLowerCase()).filter(e => e.includes('@'))))
    : String(to || '').split(',').map(x => x.trim().toLowerCase()).filter(e => e.includes('@'));

  if (!recipients.length) {
    return { ok: false, error: 'Nessun destinatario valido' };
  }
  if (!gmailTransporter) {
    return { ok: false, error: 'GMAIL_USER o GMAIL_APP_PASSWORD non configurati su Render' };
  }

  const info = await gmailTransporter.sendMail({
    from: `"UfficioCal Bot" <${GMAIL_USER}>`,
    to: recipients.join(', '),
    subject: subject || `Avviso UfficioCal: ${eventTitle || 'Impegno'}`,
    text: text || undefined,
    html: html || `<p>Notifica per l'impegno <strong>${eventTitle || 'Impegno'}</strong>.</p>`
  });

  const record = {
    id: 'mail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    to: recipients,
    subject: subject || `Avviso UfficioCal: ${eventTitle || 'Impegno'}`,
    sentAt: new Date().toISOString(),
    messageId: info.messageId || ''
  };
  state.sentEmails = [record, ...(state.sentEmails || [])].slice(0, 100);
  persistAll();
  return { ok: true, record, sentEmails: state.sentEmails };
}

function parseAlertTimestamp(ev) {
  if (!ev || !ev.alertDate || !ev.alertTime) return null;
  const isoCandidate = `${String(ev.alertDate).trim()}T${String(ev.alertTime).trim()}`;
  const ts = Date.parse(isoCandidate);
  return Number.isNaN(ts) ? null : ts;
}

async function checkScheduledAlerts() {
  purgeDeletedEvents();
  if (!Array.isArray(state.events) || !state.events.length) return;
  const nowTs = Date.now();
  let changed = false;

  for (const ev of state.events) {
    if (!ev || ev.alertSentAt) continue;
    const alertTs = parseAlertTimestamp(ev);
    if (alertTs !== null && alertTs <= nowTs) {
      const recipients = resolveRecipients(ev);
      if (recipients.length && gmailTransporter) {
        try {
          await sendMailNow({
            to: recipients,
            subject: `Alert UfficioCal: ${ev.title || 'Impegno'}`,
            eventTitle: ev.title,
            html: `<p><strong>Promemoria / Alert impegno:</strong> ${ev.title || 'Impegno'}</p><p>Data impegno: <strong>${ev.date || ''}</strong> (${ev.startTime || ''} - ${ev.endTime || ''})</p><p>Alert programmato: ${ev.alertDate} alle ${ev.alertTime}</p>`
          });
          ev.alertSentAt = new Date().toISOString();
          changed = true;
        } catch (err) {
          console.error('Errore invio alert programmato:', err.message);
        }
      } else {
        ev.alertSentAt = new Date().toISOString();
        changed = true;
      }
    }
  }

  if (changed) {
    persistAll();
  }
}

function deleteEventById(rawId) {
  const id = String(rawId || '').trim();
  if (!id) return { ok: false, status: 400, error: 'ID mancante' };
  if (!Array.isArray(state.deletedEventIds)) state.deletedEventIds = [];
  if (!state.deletedEventIds.includes(id)) {
    state.deletedEventIds.push(id);
  }
  purgeDeletedEvents();
  persistAll();
  return {
    ok: true,
    status: 200,
    deletedId: id,
    events: state.events
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, gmailConfigured: Boolean(gmailTransporter), time: new Date().toISOString() });
});

app.get('/api/state', (req, res) => {
  purgeDeletedEvents();
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
  if (Array.isArray(events)) {
    state.events = events;
  }
  if (Array.isArray(sentEmails)) {
    state.sentEmails = sentEmails;
  }
  purgeDeletedEvents();
  persistAll();
  res.json({ ok: true, state });
});

app.post('/api/events', (req, res) => {
  const ev = req.body || {};
  const id = String(ev.id || ('ev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7))).trim();
  const newEv = {
    id,
    title: String(ev.title || 'Impegno').trim(),
    date: String(ev.date || '').trim(),
    startTime: String(ev.startTime || '09:00').trim(),
    endTime: String(ev.endTime || '10:00').trim(),
    color: String(ev.color || 'blue').trim(),
    alertDate: String(ev.alertDate || ev.date || '').trim(),
    alertTime: String(ev.alertTime || ev.startTime || '09:00').trim(),
    alertCount: Number(ev.alertCount || 1),
    recipientMode: ev.recipientMode === 'selected' ? 'selected' : 'all',
    emails: Array.isArray(ev.emails) ? ev.emails : [],
    alertSentAt: null,
    createdBy: ev.createdBy || ''
  };
  state.deletedEventIds = (state.deletedEventIds || []).filter(x => String(x) !== id);
  state.events = [newEv, ...(Array.isArray(state.events) ? state.events : [])];
  purgeDeletedEvents();
  persistAll();
  res.json({ ok: true, event: newEv, events: state.events });
});

app.put('/api/events/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  const patch = req.body || {};
  let updated = null;
  state.events = (state.events || []).map(ev => {
    if (String(ev.id) !== id) return ev;
    const alertChanged = (patch.alertDate && patch.alertDate !== ev.alertDate) || (patch.alertTime && patch.alertTime !== ev.alertTime);
    updated = {
      ...ev,
      ...patch,
      alertSentAt: alertChanged ? null : ev.alertSentAt,
      id: ev.id
    };
    return updated;
  });
  purgeDeletedEvents();
  persistAll();
  res.json({ ok: Boolean(updated), event: updated, events: state.events });
});

app.delete('/api/events/:id', (req, res) => {
  const result = deleteEventById(req.params.id);
  return res.status(result.status).json(result);
});

app.post('/api/events/delete', (req, res) => {
  const id = req.body && (req.body.id ?? req.body.eventId);
  const result = deleteEventById(id);
  return res.status(result.status).json(result);
});

app.post('/api/send-email', async (req, res) => {
  const { to, subject, html, text, eventTitle, recipientMode } = req.body || {};
  const finalTo = recipientMode === 'all'
    ? Array.from(new Set([...getAllRegisteredEmails(), ...(Array.isArray(to) ? to : String(to || '').split(',').map(x => x.trim()))]))
    : to;

  try {
    const result = await sendMailNow({ to: finalTo, subject, html, text, eventTitle });
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Errore invio email' });
  }
});

app.post('/api/ai', async (req, res) => {
  const { prompt, systemInstruction } = req.body || {};
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ ok: false, error: 'Prompt mancante' });
  }
  if (!GROQ_API_KEY) {
    return res.status(500).json({ ok: false, error: 'GROQ_API_KEY non configurata' });
  }

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        temperature: 0.4,
        max_tokens: 600,
        messages: [
          ...(systemInstruction ? [{ role: 'system', content: String(systemInstruction) }] : []),
          { role: 'user', content: String(prompt) }
        ]
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: data.error?.message || 'Errore Groq API' });
    }
    const reply = data.choices?.[0]?.message?.content || '';
    res.json({ ok: true, reply });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Errore rete AI' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

loadLocal();
restoreFromCloud().then(() => checkScheduledAlerts());
setInterval(checkScheduledAlerts, 30000);

app.listen(PORT, () => {
  console.log(`UfficioCal attivo su http://localhost:${PORT}`);
});