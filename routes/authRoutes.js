// backend/routes/authRoutes.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');

const router = express.Router();

// ✅ shared DB pool (do NOT create new Pool instances in routes)
const pool = require('../db');

// utils
const { copyDefaultVariationsToUser } = require('../middleware/utils/seedUtils');

// auth middleware to read/verify JWT and set req.user
const authenticate = require('../middleware/authenticate');

// env
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

/**
 * POST /api/auth/register
 * Registers a user and seeds default product variations.
 */
router.post('/register', async (req, res) => {
  const { email = '', password = '' } = req.body;

  try {
    // optional: enforce unique emails at DB level too
    const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
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

    // Seed default variations for this user (non-fatal)
    try {
      await copyDefaultVariationsToUser(userId);
    } catch (seedErr) {
      console.warn('Seed defaults failed for user', userId, seedErr.message);
    }

    res.status(201).json({ message: 'Registered successfully', userId });
  } catch (err) {
    console.error('Register failed:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Returns JWT token + userId.
 */
router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
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
 * Validate current token, return basic user info (used for auto-login).
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    // Optionally read more fields if you want:
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
 * Verifies the token and returns subscription status.
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
 * Creates a Stripe subscription checkout session.
 */
router.post('/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

  const { email } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [
        {
          // TODO: move price id to env
          price: 'price_1RcGLnPHwSvABIr8pvE36lWS',
          quantity: 1,
        },
      ],
      success_url: `${FRONTEND_URL}/success`,
      cancel_url: `${FRONTEND_URL}/cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe session failed:', err);
    res.status(500).json({ error: 'Stripe session failed' });
  }
});

// ⚠️ Webhook is in a dedicated file (routes/stripeWebhook.js)

/**
 * GET /api/auth/test
 */
router.get('/test', (_req, res) => {
  res.json({ message: 'Auth route working' });
});

module.exports = router;
