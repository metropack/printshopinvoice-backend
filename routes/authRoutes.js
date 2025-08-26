// backend/routes/authRoutes.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');

const router = express.Router();

// shared DB pool
const pool = require('../db');

// optional seeding util
const { copyDefaultVariationsToUser } = require('../middleware/utils/seedUtils');

// auth middleware (for /me)
const authenticate = require('../middleware/authenticate');

// env
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/**
 * POST /api/auth/register
 * Create user, seed defaults, return token + userId
 */
router.post('/register', async (req, res) => {
  const { email = '', password = '' } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const exists = await pool.query('SELECT 1 FROM users WHERE lower(email)=lower($1)', [email]);
    if (exists.rowCount > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, subscription_status)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [email, hash, 'inactive']
    );
    const userId = result.rows[0].id;

    // best-effort seed
    try {
      await copyDefaultVariationsToUser(userId);
    } catch (_) {}

    const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(201).json({ message: 'Registered successfully', userId, token });
  } catch (err) {
    console.error('Register failed:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Validate credentials, return token + user fields
 */
router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';

  try {
    const result = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      token,
      userId: user.id,
      subscription_status: user.subscription_status,
    });
  } catch (err) {
    console.error('Login failed:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, subscription_status FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err) {
    console.error('Auth /me failed:', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * GET /api/auth/license-check
 */
router.get('/license-check', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'SELECT subscription_status FROM users WHERE id = $1',
      [decoded.id]
    );
    const status = result.rows[0]?.subscription_status;
    return res.json({ subscription_active: status === 'active' || status === 'trialing' });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

/**
 * POST /api/auth/create-checkout-session
 * Creates a Stripe subscription checkout session
 * If a token is provided, we use userId as client_reference_id
 */
// POST /api/auth/create-checkout-session
// Create Stripe Checkout Session (subscription)
router.post('/create-checkout-session', async (req, res) => {
  if (!stripe) {
    console.error('Stripe not configured: missing STRIPE_SECRET_KEY');
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const PRICE_ID = process.env.STRIPE_PRICE_ID;
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://mps-site-rouge.vercel.app';

  if (!PRICE_ID) {
    console.error('Missing STRIPE_PRICE_ID env var');
    return res.status(500).json({ error: 'Missing STRIPE_PRICE_ID' });
  }

  const { email = '' } = req.body;
  const normEmail = String(email).trim().toLowerCase();
  if (!normEmail || !normEmail.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  let userIdForSession = null;
  try {
    const r = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [normEmail]);
    userIdForSession = r.rows[0]?.id || null;
  } catch (dbErr) {
    console.warn('Warning: could not lookup user id for client_reference_id:', dbErr.message);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: normEmail,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      client_reference_id: userIdForSession ? String(userIdForSession) : undefined,
      metadata: userIdForSession ? { userId: String(userIdForSession) } : undefined,
      success_url: `${FRONTEND_URL}/success.html`,
      cancel_url: `${FRONTEND_URL}/cancel.html`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error(
      'create-checkout-session error:',
      err?.type || 'no-type',
      err?.message || err?.raw?.message || '(no message)',
      'price:', (process.env.STRIPE_PRICE_ID || '').slice(0, 10) + '…',
      'key mode:', (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_') ? 'LIVE' : 'TEST'
    );
    return res.status(500).json({ error: 'Stripe session failed' });
  }
});

router.get('/diag/stripe', async (_req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe not configured' });
  try {
    const price = await stripe.prices.retrieve(STRIPE_PRICE_ID);
    return res.json({
      ok: true,
      price: {
        id: price.id,
        active: price.active,
        currency: price.currency,
        type: price.type,
        recurring: price.recurring,
        livemode: price.livemode,
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});




/**
 * GET /api/auth/test
 */
router.get('/test', (_req, res) => {
  res.json({ message: 'Auth route working' });
});

module.exports = router;
