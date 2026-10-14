'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { z } = require('zod');

const BUSINESS = {
  name: 'BSM Plumbing Services',
  email: process.env.BUSINESS_EMAIL || 'info@bsmplumbingservices.co.uk',
  phone: process.env.BUSINESS_PHONE || '',
};
const PORT = Number(process.env.PORT) || 3000;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_API_KEY || '';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'enquiries.json');

/* ---------- storage (atomic JSON file, serialized writes) ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = [];
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = []; }
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.promises.rename(tmp, DB_FILE);
  }).catch((e) => console.error('Persist failed:', e));
  return writeChain;
}

/* ---------- email ---------- */
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

async function sendMail(opts) {
  if (!mailer) { console.warn('SMTP not configured; email skipped:', opts.subject); return false; }
  try {
    await mailer.sendMail({ from: `"${BUSINESS.name}" <${BUSINESS.email}>`, ...opts });
    return true;
  } catch (e) {
    console.error('Email failed:', e.message);
    return false;
  }
}

async function notify(rec) {
  const rows = Object.entries(rec.data).map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('');
  await sendMail({
    to: BUSINESS.email,
    replyTo: rec.data.email,
    subject: `New ${rec.type}: ${clean(rec.data.name)}${rec.data.urgency === 'emergency' ? ' 🚨 EMERGENCY' : ''}`,
    html: `<h2>New ${esc(rec.type)} (#${rec.id})</h2><table cellpadding="6">${rows}</table>`,
  });
  await sendMail({
    to: rec.data.email,
    subject: `We received your ${rec.type} - ${BUSINESS.name}`,
    html: `<p>Hi ${esc(rec.data.name)},</p><p>Thanks for contacting ${BUSINESS.name}. We've received your ${esc(rec.type)} (ref <b>${rec.id}</b>) and will get back to you shortly.</p>${BUSINESS.phone ? `<p>For emergencies call <b>${esc(BUSINESS.phone)}</b>.</p>` : ''}<p>${BUSINESS.name}<br>${BUSINESS.email}</p>`,
  });
}

/* ---------- validation ---------- */
const ukPhone = z.string().trim().regex(/^(?:\+44|0)[\d\s-]{9,13}$/, 'Invalid UK phone number');
const base = {
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: ukPhone,
  postcode: z.string().trim().regex(/^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/, 'Invalid UK postcode'),
  website: z.string().max(0).optional(), // honeypot
};
const SERVICES = ['boiler', 'leak', 'blocked-drain', 'bathroom', 'heating', 'tap-toilet', 'gas-safety', 'other'];
const schemas = {
  contact: z.object({ ...base, message: z.string().trim().min(5).max(3000) }).strict(),
  quote: z.object({
    ...base,
    service: z.enum(SERVICES),
    urgency: z.enum(['emergency', 'soon', 'flexible']).default('flexible'),
    message: z.string().trim().min(5).max(3000),
  }).strict(),
  booking: z.object({
    ...base,
    service: z.enum(SERVICES),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slot: z.enum(['morning', 'afternoon', 'evening']),
    address: z.string().trim().min(5).max(300),
    message: z.string().trim().max(2000).optional().default(''),
  }).strict(),
};

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameSrc: ['https://www.google.com'],
    },
  },
}));
app.use(compression());
const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use('/api', cors({ origin: origins.length ? origins : false, methods: ['GET', 'POST', 'PATCH'] }));
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const t = process.hrtime.bigint();
  res.on('finish', () => console.log(JSON.stringify({
    id: req.id, method: req.method, url: req.originalUrl.split('?')[0], status: res.statusCode,
    ms: Number(process.hrtime.bigint() - t) / 1e6 | 0,
  })));
  next();
});

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
const formLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many submissions, please try again later or call us.' },
});
app.use('/api', apiLimiter);

/* ---------- public API ---------- */
app.get('/api/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime(), mail: !!mailer }));

app.get('/api/business', (_req, res) => res.json({
  name: BUSINESS.name, email: BUSINESS.email, phone: BUSINESS.phone, services: SERVICES,
  reviewUrl: process.env.GOOGLE_REVIEW_URL || null,
}));

for (const type of Object.keys(schemas)) {
  app.post(`/api/${type}`, formLimiter, async (req, res, next) => {
    try {
      const parsed = schemas[type].safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) });
      }
      const { website, ...data } = parsed.data;
      if (website) return res.status(201).json({ ok: true }); // bot: pretend success
      if (type === 'booking') {
        const d = new Date(data.date + 'T00:00:00Z');
        const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
        if (isNaN(d) || d < today || d.toISOString().slice(0, 10) !== data.date) {
          return res.status(400).json({ error: 'Date must be a valid date today or later' });
        }
        if (db.some((r) => r.type === 'booking' && r.status !== 'cancelled' && r.data.date === data.date && r.data.slot === data.slot && r.data.postcode.replace(/\s/g, '').toUpperCase() === data.postcode.replace(/\s/g, '').toUpperCase())) {
          return res.status(409).json({ error: 'That slot is no longer available' });
        }
      }
      const rec = { id: crypto.randomBytes(4).toString('hex').toUpperCase(), type, status: 'new', createdAt: new Date().toISOString(), ip: req.ip, data };
      db.push(rec);
      await persist();
      notify(rec).catch((e) => console.error(e));
      res.status(201).json({ ok: true, reference: rec.id });
    } catch (e) { next(e); }
  });
}

/* ---------- Google reviews (Places API, cached 6h) ---------- */
let reviewCache = { at: 0, data: null };
app.get('/api/reviews', async (_req, res) => {
  const key = process.env.GOOGLE_PLACES_API_KEY, placeId = process.env.GOOGLE_PLACE_ID;
  if (!key || !placeId) return res.status(503).json({ error: 'Google reviews not configured' });
  if (reviewCache.data && Date.now() - reviewCache.at < 6 * 3600_000) return res.json(reviewCache.data);
  try {
    const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'rating,userRatingCount,reviews' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Places API ${r.status}`);
    const j = await r.json();
    reviewCache = {
      at: Date.now(),
      data: {
        rating: j.rating, count: j.userRatingCount,
        reviews: (j.reviews || []).map((v) => ({
          author: v.authorAttribution?.displayName, rating: v.rating,
          text: v.text?.text, when: v.relativePublishTimeDescription,
        })),
      },
    };
    res.json(reviewCache.data);
  } catch (e) {
    console.error('Reviews failed:', e.message);
    if (reviewCache.data) return res.json(reviewCache.data);
    res.status(502).json({ error: 'Could not fetch reviews' });
  }
});

/* ---------- admin API ---------- */
function admin(req, res, next) {
  const given = Buffer.from(req.get('x-api-key') || '');
  const want = Buffer.from(ADMIN_KEY);
  if (!ADMIN_KEY || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
const adminLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 100 });
app.use('/api/admin', adminLimiter, admin);

app.get('/api/admin/enquiries', (req, res) => {
  const { type, status } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 25));
  const list = db.filter((r) => (!type || r.type === type) && (!status || r.status === status)).slice().reverse();
  res.json({ total: list.length, page, size, items: list.slice((page - 1) * size, page * size) });
});
app.patch('/api/admin/enquiries/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ status: z.enum(['new', 'contacted', 'scheduled', 'completed', 'cancelled']) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid status' });
    const rec = db.find((r) => r.id === req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    rec.status = parsed.data.status;
    await persist();
    res.json(rec);
  } catch (e) { next(e); }
});
app.get('/api/admin/stats', (_req, res) => {
  const by = (k) => db.reduce((a, r) => ((a[r[k]] = (a[r[k]] || 0) + 1), a), {});
  res.json({ total: db.length, byType: by('type'), byStatus: by('status') });
});

/* ---------- SEO ---------- */
const hasAddr = process.env.BUSINESS_ADDRESS_CITY || process.env.BUSINESS_ADDRESS_POSTCODE;
app.get('/schema.json', (_req, res) => {
  const ld = {
    '@context': 'https://schema.org', '@type': 'Plumber', name: BUSINESS.name, url: SITE_URL,
    email: BUSINESS.email, areaServed: 'GB', priceRange: '££',
    ...(BUSINESS.phone && { telephone: BUSINESS.phone }),
    ...(hasAddr && { address: {
      '@type': 'PostalAddress', streetAddress: process.env.BUSINESS_ADDRESS_STREET || undefined,
      addressLocality: process.env.BUSINESS_ADDRESS_CITY || undefined,
      postalCode: process.env.BUSINESS_ADDRESS_POSTCODE || undefined, addressCountry: 'GB',
    } }),
    ...(process.env.BUSINESS_LAT && process.env.BUSINESS_LNG && { geo: { '@type': 'GeoCoordinates', latitude: +process.env.BUSINESS_LAT, longitude: +process.env.BUSINESS_LNG } }),
    ...(process.env.GOOGLE_REVIEW_URL && { sameAs: [process.env.GOOGLE_REVIEW_URL] }),
  };
  res.type('application/ld+json').json(ld);
});
app.get('/robots.txt', (_req, res) => res.type('text/plain').send(`User-agent: *\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap.xml\n`));
app.get('/sitemap.xml', (_req, res) => res.type('application/xml').send(
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE_URL}/</loc></url></urlset>`));

/* ---------- static + errors ---------- */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((_req, res) => res.status(404).send('Not found'));
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  console.error(req.id, err);
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
});

const server = app.listen(PORT, () => {
  console.log(`${BUSINESS.name} server on :${PORT}`);
  if (!ADMIN_KEY) console.warn('ADMIN_API_KEY not set: admin API disabled');
});
function shutdown() {
  server.close(() => writeChain.finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => console.error('Unhandled rejection', e));
