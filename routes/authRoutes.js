// backend/routes/authRoutes.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');

const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');
// optional: seed defaults for a new user
const { copyDefaultVariationsToUser } = require('../middleware/utils/seedUtils');

// ---- env ----
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

// Small helper
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

/**
 * POST /api/auth/register
 * Body: { email, password }
 * Creates the user (subscription_status = 'inactive'), seeds defaults,
 * and returns a JWT so the user is logged in immediately.
 */
router.post('/register', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const exists = await pool.query(
      'SELECT 1 FROM users WHERE lower(email) = lower($1)',
      [email]
    );
    if (exists.rowCount > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, subscription_status)
       VALUES ($1, $2, 'inactive')
       RETURNING id, email, subscription_status`,
      [email, hash]
    );

    const user = rows[0];

    // Seed defaults (non-fatal)
    try {
      await copyDefaultVariationsToUser(user.id);
    } catch (err) {
      console.warn('Seed defaults failed for user', user.id, err.message);
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'Registered successfully',
      token,
      userId: user.id,
      subscription_status: user.subscription_status,
    });
  } catch (err) {
    console.error('Register failed:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Returns JWT token + user info.
 */
router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  try {
    const result = await pool.query('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      userId: user.id,
      subscription_status: user.subscription_status,
    });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/auth/me
 * Requires Authorization: Bearer <token>
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, subscription_status FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('Auth /me failed:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * GET /api/auth/license-check
 * Reads token from Authorization header, returns { subscription_active: boolean }.
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
    res.json({ subscription_active: status === 'active' });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/**
 * POST /api/auth/create-checkout-session
 * Requires Authorization: Bearer <token>
 * Creates/reuses a Stripe Customer for the logged-in user and starts a subscription checkout.
 */
router.post('/create-checkout-session', authenticate, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    if (!STRIPE_PRICE_ID) return res.status(500).json({ error: 'Missing STRIPE_PRICE_ID' });

    const userId = req.user.id;

    // Fetch user
    const { rows } = await pool.query(
      'SELECT email, stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Create or reuse Customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: String(userId) },
      });
      customerId = customer.id;
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, userId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      // we recommend /success.html & /cancel.html (you created those)
      success_url: `${FRONTEND_URL}/success.html`,
      cancel_url:  `${FRONTEND_URL}/cancel.html`,
      // these let the webhook link the event → user
      client_reference_id: String(userId),
      metadata: { userId: String(userId) },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe session failed:', err?.message || err);
    res.status(500).json({ error: 'Stripe session failed' });
  }
});

/** Simple health check */
router.get('/test', (_req, res) => {
  res.json({ message: 'Auth route working' });
});

module.exports = router;
