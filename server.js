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
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const BOT_FROM = (process.env.BOT_FROM || '').trim();
const DEFAULT_SITE_URL = (process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || 'https://ufficio-2-jw4e.onrender.com').trim().replace(/\/+$/, '');

const COLOR_LABELS = {
  blue: 'Blu',
  green: 'Verde',
  amber: 'Ambra',
  red: 'Rosso',
  purple: 'Viola'
};

function getColorLabel(color) {
  const key = String(color || 'blue').trim().toLowerCase();
  return COLOR_LABELS[key] || (color || 'Blu');
}

function getSiteUrl(req) {
  if (DEFAULT_SITE_URL) return DEFAULT_SITE_URL;
  if (req && req.get('host')) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    return `${proto}://${req.get('host')}`;
  }
  return 'https://ufficio-2-jw4e.onrender.com';
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const gmailTransporter = (GMAIL_USER && GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
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
        const mergedUsers = Array.isArray(parsed.users) ? [...parsed.users] : [];
        (state.users || []).forEach(u => {
          if (u && u.email && !mergedUsers.some(x => String(x.email || '').toLowerCase() === String(u.email).toLowerCase())) {
            mergedUsers.push(u);
          }
        });
        state = {
          users: mergedUsers,
          events: Array.isArray(parsed.events) && parsed.events.length ? parsed.events : state.events,
          sentEmails: Array.isArray(parsed.sentEmails) && parsed.sentEmails.length ? parsed.sentEmails : state.sentEmails,
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
  const creator = evOrObj && evOrObj.createdBy ? String(evOrObj.createdBy).trim().toLowerCase() : '';
  if (mode === 'all') {
    const all = getAllRegisteredEmails();
    return Array.from(new Set([...all, ...explicit, ...(creator.includes('@') ? [creator] : [])]));
  }
  return Array.from(new Set([...explicit, ...(explicit.length === 0 && creator.includes('@') ? [creator] : [])]));
}

function buildMailHtml({ bodyHtml, text, colorLabel, siteUrl }) {
  const safeUrl = escapeHtml(siteUrl || getSiteUrl());
  const safeColor = escapeHtml(colorLabel || '');
  const inner = bodyHtml || `<p>${escapeHtml(text || 'Notifica inviata da UfficioCal.')}</p>`;
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#0f172a;">
      ${inner}
      ${safeColor ? `<p><strong>Colore impegno:</strong> ${safeColor}</p>` : ''}
      <p><strong>Apri UfficioCal:</strong> <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a></p>
    </div>
  `.trim();
}

function buildMailText({ text, colorLabel, siteUrl }) {
  const lines = [];
  if (text) lines.push(String(text));
  if (colorLabel) lines.push(`Colore impegno: ${colorLabel}`);
  lines.push(`Apri UfficioCal: ${siteUrl || getSiteUrl()}`);
  return lines.join('\n');
}

async function sendViaResend({ recipients, subject, html, text }) {
  const fromAddr = BOT_FROM || (GMAIL_USER ? `UfficioCal Bot <${GMAIL_USER}>` : 'UfficioCal Bot <onboarding@resend.dev>');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromAddr,
      to: recipients,
      subject,
      html,
      text
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.message || data.error?.message || `Resend HTTP ${resp.status}`);
  }
  return data.id || 'resend_ok';
}

async function sendMailNow({ to, subject, html, text, eventTitle, color, siteUrl }) {
  const recipients = Array.isArray(to)
    ? Array.from(new Set(to.map(x => String(x || '').trim().toLowerCase()).filter(e => e.includes('@'))))
    : String(to || '').split(',').map(x => x.trim().toLowerCase()).filter(e => e.includes('@'));

  if (!recipients.length) {
    return { ok: false, error: 'Nessun destinatario valido (inserisci un indirizzo o registra un utente)' };
  }

  const resolvedUrl = siteUrl || getSiteUrl();
  const colorLabel = color ? getColorLabel(color) : '';
  const finalSubject = subject || `Avviso UfficioCal: ${eventTitle || 'Impegno'}`;
  const finalHtml = buildMailHtml({ bodyHtml: html, text, colorLabel, siteUrl: resolvedUrl });
  const finalText = buildMailText({ text: text || (eventTitle ? `Notifica impegno: ${eventTitle}` : ''), colorLabel, siteUrl: resolvedUrl });

  const errors = [];

  if (gmailTransporter) {
    try {
      const info = await gmailTransporter.sendMail({
        from: `"UfficioCal Bot" <${GMAIL_USER}>`,
        to: recipients.join(', '),
        subject: finalSubject,
        text: finalText,
        html: finalHtml
      });
      const record = {
        id: 'mail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        to: recipients,
        subject: finalSubject,
        color: colorLabel || undefined,
        provider: 'gmail',
        sentAt: new Date().toISOString(),
        messageId: info.messageId || ''
      };
      state.sentEmails = [record, ...(state.sentEmails || [])].slice(0, 100);
      persistAll();
      return { ok: true, record, sentEmails: state.sentEmails };
    } catch (err) {
      errors.push(`Gmail: ${err.code || 'SMTP'} - ${err.response || err.message}`);
    }
  }

  if (RESEND_API_KEY) {
    try {
      const msgId = await sendViaResend({ recipients, subject: finalSubject, html: finalHtml, text: finalText });
      const record = {
        id: 'mail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        to: recipients,
        subject: finalSubject,
        color: colorLabel || undefined,
        provider: 'resend',
        sentAt: new Date().toISOString(),
        messageId: msgId
      };
      state.sentEmails = [record, ...(state.sentEmails || [])].slice(0, 100);
      persistAll();
      return { ok: true, record, sentEmails: state.sentEmails };
    } catch (err) {
      errors.push(`Resend: ${err.message}`);
    }
  }

  if (!errors.length) {
    return { ok: false, error: 'Nessun provider mail configurato (mancano credenziali Gmail e RESEND_API_KEY)' };
  }
  return { ok: false, error: errors.join(' | ') };
}

function normalizeAlerts(ev) {
  if (Array.isArray(ev.alerts) && ev.alerts.length) {
    return ev.alerts.map((a, idx) => ({
      index: idx + 1,
      date: String((a && a.date) || ev.date || '').trim(),
      time: String((a && a.time) || ev.startTime || '09:00').trim(),
      sentAt: a && a.sentAt ? a.sentAt : null
    }));
  }
  const count = Math.max(1, Math.min(10, Number(ev.alertCount || 1)));
  const baseDate = String(ev.alertDate || ev.date || '').trim();
  const baseTime = String(ev.alertTime || ev.startTime || '09:00').trim();
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({
      index: i + 1,
      date: baseDate,
      time: baseTime,
      sentAt: i === 0 && ev.alertSentAt ? ev.alertSentAt : null
    });
  }
  return arr;
}

function parseAlertTs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const dMatch = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tMatch = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!dMatch || !tMatch) return null;

  const year = Number(dMatch[1]);
  const month = Number(dMatch[2]);
  const day = Number(dMatch[3]);
  const hour = Number(tMatch[1]);
  const minute = Number(tMatch[2]);

  // Costruiamo un timestamp UTC iniziale con i valori inseriti
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Leggiamo come viene visto quel momento in Europe/Rome per ricavare l'offset esatto
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = fmt.formatToParts(new Date(utcMs));
  const getP = (type) => Number(parts.find(p => p.type === type)?.value || 0);
  const romeAsUtcMs = Date.UTC(
    getP('year'),
    getP('month') - 1,
    getP('day'),
    getP('hour') === 24 ? 0 : getP('hour'),
    getP('minute'),
    getP('second'),
    0
  );

  // offsetMs = (ora in Roma) - (ora UTC)
  const offsetMs = romeAsUtcMs - utcMs;
  // L'istante reale UTC corrispondente all'ora locale inserita è (ora locale inserita) - offsetMs
  return utcMs - offsetMs;
}
async function checkScheduledAlerts() {
  purgeDeletedEvents();
  if (!Array.isArray(state.events) || !state.events.length) return;
  const nowTs = Date.now();
  let changed = false;

  for (const ev of state.events) {
    if (!ev) continue;
    ev.alerts = normalizeAlerts(ev);
    const recipients = resolveRecipients(ev);
    const colorLabel = getColorLabel(ev.color);

    for (const al of ev.alerts) {
      if (al.sentAt) continue;
      const alTs = parseAlertTs(al.date, al.time);
      if (alTs !== null && alTs <= nowTs) {
        if (recipients.length && (gmailTransporter || RESEND_API_KEY)) {
          const res = await sendMailNow({
            to: recipients,
            subject: `Alert #${al.index} UfficioCal: ${ev.title || 'Impegno'}`,
            eventTitle: ev.title,
            color: colorLabel,
            siteUrl: DEFAULT_SITE_URL,
            html: `<p><strong>Alert #${al.index} per l'impegno:</strong> ${escapeHtml(ev.title || 'Impegno')}</p><p><strong>Data impegno:</strong> ${escapeHtml(ev.date || '')} (${escapeHtml(ev.startTime || '')} - ${escapeHtml(ev.endTime || '')})</p><p><strong>Orario alert impostato:</strong> ${escapeHtml(al.date)} alle ${escapeHtml(al.time)}</p>`
          });
          if (res.ok) {
            al.sentAt = new Date().toISOString();
            changed = true;
          } else {
            console.error('Alert non inviato:', res.error);
          }
        } else {
          al.sentAt = new Date().toISOString();
          changed = true;
        }
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
  res.json({
    ok: true,
    gmailUserSet: Boolean(GMAIL_USER),
    gmailPassSet: Boolean(GMAIL_APP_PASSWORD),
    resendSet: Boolean(RESEND_API_KEY),
    siteUrl: getSiteUrl(req),
    registeredUsersCount: (state.users || []).length,
    serverNowIso: new Date().toISOString(),
    time: new Date().toISOString()
  });
});

app.get('/api/alerts-debug', (req, res) => {
  const nowTs = Date.now();
  const pending = [];
  for (const ev of (state.events || [])) {
    const alerts = normalizeAlerts(ev);
    for (const al of alerts) {
      const ts = parseAlertTs(al.date, al.time);
      pending.push({
        eventId: ev.id,
        title: ev.title,
        alertIndex: al.index,
        date: al.date,
        time: al.time,
        parsedIso: ts ? new Date(ts).toISOString() : null,
        isDue: ts !== null ? ts <= nowTs : false,
        sentAt: al.sentAt || null,
        recipients: resolveRecipients(ev)
      });
    }
  }
  res.json({ nowIso: new Date(nowTs).toISOString(), alerts: pending });
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
  const alerts = normalizeAlerts(ev);
  const newEv = {
    id,
    title: String(ev.title || 'Impegno').trim(),
    date: String(ev.date || '').trim(),
    startTime: String(ev.startTime || '09:00').trim(),
    endTime: String(ev.endTime || '10:00').trim(),
    color: String(ev.color || 'blue').trim(),
    alertDate: alerts[0]?.date || String(ev.date || '').trim(),
    alertTime: alerts[0]?.time || String(ev.startTime || '09:00').trim(),
    alertCount: alerts.length,
    alerts,
    recipientMode: ev.recipientMode === 'selected' ? 'selected' : 'all',
    emails: Array.isArray(ev.emails) ? ev.emails : [],
    createdBy: ev.createdBy || ''
  };
  state.deletedEventIds = (state.deletedEventIds || []).filter(x => String(x) !== id);
  state.events = [newEv, ...(Array.isArray(state.events) ? state.events : [])];
  purgeDeletedEvents();
  persistAll();
  checkScheduledAlerts();
  res.json({ ok: true, event: newEv, events: state.events });
});

app.put('/api/events/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  const patch = req.body || {};
  let updated = null;
  state.events = (state.events || []).map(ev => {
    if (String(ev.id) !== id) return ev;
    const merged = { ...ev, ...patch, id: ev.id };
    const alerts = normalizeAlerts(merged);
    updated = {
      ...merged,
      alertDate: alerts[0]?.date || merged.date,
      alertTime: alerts[0]?.time || merged.startTime,
      alertCount: alerts.length,
      alerts
    };
    return updated;
  });
  purgeDeletedEvents();
  persistAll();
  checkScheduledAlerts();
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
  const { to, subject, html, text, eventTitle, recipientMode, color } = req.body || {};
  const explicitList = Array.isArray(to)
    ? to
    : String(to || '').split(',').map(x => x.trim()).filter(Boolean);
  const finalTo = recipientMode === 'all'
    ? Array.from(new Set([...getAllRegisteredEmails(), ...explicitList]))
    : explicitList;

  const result = await sendMailNow({
    to: finalTo,
    subject,
    html,
    text,
    eventTitle,
    color,
    siteUrl: getSiteUrl(req)
  });
  if (!result.ok) {
    return res.status(400).json(result);
  }
  res.json(result);
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
setInterval(checkScheduledAlerts, 15000);

app.listen(PORT, () => {
  console.log(`UfficioCal attivo su http://localhost:${PORT}`);
});