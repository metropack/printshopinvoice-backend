const path = require('path');

// Load .env from backend/.env explicitly (local). On Render, dashboard envs still win.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const p = require('path');
// const morgan = require('morgan');

const app = express();
app.set('trust proxy', 1);

/* ───────────────────────── Router resolver ─────────────────────────
   Makes app.use(...) safe if a route module exports {router}, or default, or the router itself.
--------------------------------------------------------------------- */
const resolveRouter = (mod) => (mod && (mod.router || mod.default)) || mod;

/* ───────────────────────── CORS (relaxed for now) ───────────────────────── */
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// “allow all” while debugging if no ALLOWED_ORIGINS set
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);                 // curl / server-to-server
    if (allowed.length === 0) return cb(null, true);    // debug: allow all
    if (allowed.includes(origin)) return cb(null, true);
    if (origin === 'null') return cb(null, true);       // file:// (Electron)
    return cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

/* ───────────────────────── Early request log ───────────────────────── */
app.use((req, _res, next) => {

  next();
});

/* ───────────────────────── Liveness (NO AUTH) ───────────────────────── */
app.get('/api/ping', (_req, res) => res.json({ ok: true, at: '/api/ping', t: Date.now() }));
app.get('/__up',      (_req, res) => res.json({ ok: true, at: '/__up',      t: Date.now() }));

/* ───────────────────────── Stripe webhook (raw body) ─────────────────────────
   IMPORTANT: mount this precisely so it cannot catch all of /api/*
--------------------------------------------------------------------------- */
const stripeWebhookMod = require('./routes/stripeWebhook');
const stripeWebhook = resolveRouter(stripeWebhookMod);
app.use('/api/webhook', stripeWebhook);

/* ───────────────────────── Body parsers & access log ───────────────────────── */
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
// app.use(morgan('tiny'));

// Debug/diagnostic routes (no auth). Keep while debugging, remove later.
const diagMod = require('./routes/diag');
app.use('/api/_debug', resolveRouter(diagMod));
const debugEmailMod = require('./routes/debugEmail');
app.use('/api/_debug', resolveRouter(debugEmailMod));

/* ───────────────────────── Static ───────────────────────── */
app.use('/invoices', express.static(p.join(__dirname, 'invoices')));
app.use('/uploads',  express.static(p.join(__dirname, 'uploads')));
const supportRoutesMod = require('./routes/support');
app.use('/api', resolveRouter(supportRoutesMod));  // <-- gives you /api/support

/* ───────────────────────── Routes ───────────────────────── */
const authRoutesMod        = require('./routes/authRoutes');
const passwordResetMod     = require('./routes/passwordReset');

const estimatesRoutesMod   = require('./routes/estimates');
const invoicesRoutesMod    = require('./routes/invoices');
const customersRoutesMod   = require('./routes/customers');
const productsRoutesMod    = require('./routes/products');
const reportsRoutesMod     = require('./routes/reports');
const customTabsRoutesMod  = require('./routes/customTabs');
const storeInfoRoutesMod   = require('./routes/storeInfoRoutes');
const profileRoutesMod     = require('./routes/profile');
const billingRoutesMod     = require('./routes/billing');

const authenticate      = require('./middleware/authenticate');
const subscriptionGuard = require('./middleware/subscriptionGuard');

/* public */
app.use('/api/auth', resolveRouter(passwordResetMod));
app.use('/api/auth', resolveRouter(authRoutesMod));

/* ✅ Notification routes (admin email notifications, tests, etc.) */
const notifyMod = require('./routes/notify');
app.use('/api/notify', resolveRouter(notifyMod));

/* protected (require auth; most also require active subscription) */
app.use('/api/profile',  authenticate, resolveRouter(profileRoutesMod));
app.use('/api/billing',  authenticate, resolveRouter(billingRoutesMod));

// ── TEMPORARY TOGGLE: allow bypassing subscriptionGuard for targeted routes ──
// Set BYPASS_SUB_GUARD=1 in env to mount these routes without the guard.
// Everything else remains unchanged.
const useGuard = process.env.BYPASS_SUB_GUARD !== '1';
if (useGuard) {
  app.use('/api/products',    authenticate, subscriptionGuard, resolveRouter(productsRoutesMod));
  app.use('/api/invoices',    authenticate, subscriptionGuard, resolveRouter(invoicesRoutesMod));
} else {
  console.warn('[boot] BYPASS_SUB_GUARD=1 → mounting /api/products & /api/invoices WITHOUT subscriptionGuard');
  app.use('/api/products',    authenticate, resolveRouter(productsRoutesMod));
  app.use('/api/invoices',    authenticate, resolveRouter(invoicesRoutesMod));
}

// All the rest keep the guard as before
app.use('/api/estimates',   authenticate, subscriptionGuard, resolveRouter(estimatesRoutesMod));
app.use('/api/customers',   authenticate, subscriptionGuard, resolveRouter(customersRoutesMod));
app.use('/api/reports',     authenticate, subscriptionGuard, resolveRouter(reportsRoutesMod));
app.use('/api/custom_tabs', authenticate, subscriptionGuard, resolveRouter(customTabsRoutesMod));
app.use('/api/store-info',  authenticate, subscriptionGuard, resolveRouter(storeInfoRoutesMod));

/* ✅ Downloads (presigned S3) — mount BEFORE 404 */
const downloadsMod = require('./routes/downloads');
app.use('/api', resolveRouter(downloadsMod));

/* root */
app.get('/', (_req, res) => res.send('Backend is working!'));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

/* ───────────────────────── 404 & error JSON ───────────────────────── */
app.use((req, res, _next) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res
    .status(err.status || err.statusCode || 500)
    .json({ error: err.message || 'Server error' });
});

/* ───────────────────────── start ───────────────────────── */
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is live on port ${PORT}`);
});
