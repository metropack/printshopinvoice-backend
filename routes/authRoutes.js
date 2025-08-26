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
router.post('/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) throw new Error('Stripe secret key is missing');
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const PRICE_ID = process.env.STRIPE_PRICE_ID;
    if (!PRICE_ID) throw new Error('Missing STRIPE_PRICE_ID');

    // Safety check: if PRICE_ID is wrong or archived, this will throw
    await stripe.prices.retrieve(PRICE_ID);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${process.env.FRONTEND_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/cancel.html`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    // Log and surface details so we immediately know why it failed
    console.error('create-checkout-session failed:', {
      message: err.message,
      type: err.type,
      code: err.code,
    });
    return res.status(500).json({
      error: 'Stripe session failed',
      detail: err.message,  // keep during setup; remove later if you prefer
      type: err.type,
      code: err.code,
    });
  }
});


/**
 * GET /api/auth/test
 */
router.get('/test', (_req, res) => {
  res.json({ message: 'Auth route working' });
});

module.exports = router;
