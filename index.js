// backend/index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// ---- Routes ----
const stripeWebhookRoutes = require('./routes/stripeWebhook'); // MUST be before parsers
const authRoutes         = require('./routes/authRoutes');
const estimatesRoutes    = require('./routes/estimates');
const invoicesRoutes     = require('./routes/invoices');
const customersRoutes    = require('./routes/customers');
const productsRoutes     = require('./routes/products');
const reportsRoutes      = require('./routes/reports');
const customTabsRoutes   = require('./routes/customTabs');
const storeInfoRoutes    = require('./routes/storeInfoRoutes'); // exact case

// ---- Guards (Option A: apply at mount) ----
const authenticate       = require('./middleware/authenticate');
const subscriptionGuard  = require('./middleware/subscriptionGuard');

// ---- Stripe webhook BEFORE body parsers ----
app.use('/api', stripeWebhookRoutes);

// ---- Core middleware ----
const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, cb) {
    // allow same-origin (no header), explicit allowlist, and 'null' (Electron file://)
    if (!origin || allowed.includes(origin) || (origin === 'null' && allowed.includes('null'))) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));


app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ---- Static assets ----
app.use('/invoices', express.static(path.join(__dirname, 'invoices')));
app.use('/uploads',  express.static(path.join(__dirname, 'uploads')));

// ---- Public routes ----
app.use('/api/auth', authRoutes);          // login/register/me
// (webhook already mounted above at /api)

// ---- Protected routes (auth + active subscription) ----
app.use('/api/estimates',    authenticate, subscriptionGuard, estimatesRoutes);
app.use('/api/invoices',     authenticate, subscriptionGuard, invoicesRoutes);
app.use('/api/customers',    authenticate, subscriptionGuard, customersRoutes);
app.use('/api/products',     authenticate, subscriptionGuard, productsRoutes);
app.use('/api/reports',      authenticate, subscriptionGuard, reportsRoutes);
app.use('/api/custom_tabs',  authenticate, subscriptionGuard, customTabsRoutes);
app.use('/api/store-info',   authenticate, subscriptionGuard, storeInfoRoutes);

// ---- Misc ----
app.get('/', (_req, res) => res.send('Backend is working!'));
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is live on port ${PORT}`);
});
