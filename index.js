// backend/index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// ---- Routes ----
const stripeWebhookRoutes = require('./routes/stripeWebhook'); // must be before json body parser
const authRoutes         = require('./routes/authRoutes');
const estimatesRoutes    = require('./routes/estimates');
const invoicesRoutes     = require('./routes/invoices');
const customersRoutes    = require('./routes/customers');
const productsRoutes     = require('./routes/products');
const reportsRoutes      = require('./routes/reports');
const customTabsRoutes   = require('./routes/customTabs');
const storeInfoRoutes    = require('./routes/storeInfoRoutes');

const authenticate       = require('./middleware/authenticate');
const subscriptionGuard  = require('./middleware/subscriptionGuard');
const profileRoutes      = require('./routes/profile');
const billingRoutes      = require('./routes/billing');

/* ---------------- CORS FIRST (for ALL routes & errors) ---------------- */
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    // allow same-origin / server-to-server / curl (no Origin header)
    if (!origin) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    if (origin === 'null' && allowed.includes('null')) return cb(null, true); // if you need file:// (Electron)
    return cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // handle preflight globally
/* --------------------------------------------------------------------- */

/* ---- Stripe webhook BEFORE body parser (CORS can be before it) ---- */
app.use('/api', stripeWebhookRoutes);

/* ---------------- Body parsers ---------------- */
app.use(express.json({ limit: '25mb' }));

const passwordResetRoutes = require('./routes/passwordReset');
app.use('/api/auth', passwordResetRoutes);

app.use(express.urlencoded({ extended: true, limit: '25mb' }));

/* ---------------- Static assets ---------------- */
app.use('/invoices', express.static(path.join(__dirname, 'invoices')));
app.use('/uploads',  express.static(path.join(__dirname, 'uploads')));

/* ---------------- Public routes ---------------- */
app.use('/api/auth', authRoutes);

/* ---------------- Protected routes ---------------- */
app.use('/api/profile',  authenticate, profileRoutes);
app.use('/api/billing',  authenticate, billingRoutes);

app.use('/api/estimates',   authenticate, subscriptionGuard, estimatesRoutes);
app.use('/api/invoices',    authenticate, subscriptionGuard, invoicesRoutes);
app.use('/api/customers',   authenticate, subscriptionGuard, customersRoutes);
app.use('/api/products',    authenticate, subscriptionGuard, productsRoutes);
app.use('/api/reports',     authenticate, subscriptionGuard, reportsRoutes);
app.use('/api/custom_tabs', authenticate, subscriptionGuard, customTabsRoutes);
app.use('/api/store-info',  authenticate, subscriptionGuard, storeInfoRoutes);

/* ---------------- Misc ---------------- */
app.get('/', (_req, res) => res.send('Backend is working!'));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is live on port ${PORT}`);
});
