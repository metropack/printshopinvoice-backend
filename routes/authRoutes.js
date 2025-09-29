// backend/routes/authRoutes.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const crypto = require('crypto');
const { Resend } = require('resend');

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

// email (password reset)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@example.com';

// ------------ NEW: support signup notification ------------
const SUPPORT_NOTIFY_TO =
  process.env.SUPPORT_NOTIFY_TO || 'support@printshopinvoice.com';

async function notifySupportSignup({ userId, email }) {
  const subject = `🆕 New signup: ${email}`;
  const html = `
    <h2>New user signed up</h2>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>User ID:</strong> ${userId}</p>
    <p><strong>Time (UTC):</strong> ${new Date().toISOString()}</p>
  `;
  const text =
    `New user signed up\n` +
    `Email: ${email}\n` +
    `User ID: ${userId}\n` +
    `Time: ${new Date().toISOString()}\n`;

  if (resend) {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: SUPPORT_NOTIFY_TO,
      subject,
      html,
      text,
    });
  } else {
    // If email isn't configured, don't block signup—just log.
    console.log('[notifySupportSignup]', { to: SUPPORT_NOTIFY_TO, subject, email, userId });
  }
}
// ---------------------------------------------------------

// ---- helpers for password reset ----
function makeToken() {
  return crypto.randomBytes(32).toString('hex'); // plaintext token (emailed)
}
function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex'); // stored hash
}
async function sendResetEmail(to, link) {
  if (!resend) throw new Error('Email not configured');
  await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Reset your MPS Invoice App password',
    html: `
      <p>We received a request to reset your password.</p>
      <p><a href="${link}">Click here to reset your password</a></p>
      <p>If you didn’t request this, you can ignore this email.</p>
      <p>This link expires in 60 minutes.</p>
    `,
  });
}

// 🔐 Password policy: ≥8 chars, at least 1 letter, 1 number, 1 special char
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

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

    // ✅ Enforce strong password
    if (!PASSWORD_RE.test(password)) {
      return res.status(400).json({
        error:
          'Password must be at least 8 characters and include a letter, a number, and a special character.',
      });
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

    // 🔔 fire-and-forget support email (does NOT block response)
    notifySupportSignup({ userId, email }).catch(e =>
      console.warn('notifySupportSignup failed:', e.message)
    );

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

// simple Stripe diagnostics
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
 * POST /api/auth/password/forgot { email }
 * Always returns ok (to avoid email enumeration).
 */
router.post('/password/forgot', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(email)=$1', [email]);
    const user = rows[0];

    // Always pretend success
    if (!user) return res.json({ ok: true });

    // optional: ensure table exists separately (migration)
    const token = makeToken();
    const tokenHash = hashToken(token);
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 60 minutes

    await pool.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [user.id]);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expires]
    );

    const link = `${FRONTEND_URL}/reset.html?token=${encodeURIComponent(token)}`;
    try { await sendResetEmail(email, link); } catch (e) {
      console.warn('sendResetEmail failed:', e.message);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('password/forgot error:', e.message);
    return res.json({ ok: true });
  }
});

/**
 * POST /api/auth/password/reset { token, password }
 */
router.post('/password/reset', async (req, res) => {
  const token = (req.body.token || '').trim();
  const password = req.body.password || '';

  // ✅ apply strong-password rule here as well
  if (!token || !PASSWORD_RE.test(password)) {
    return res.status(400).json({
      error:
        'Invalid token or weak password. Use at least 8 characters including a letter, a number, and a special character.',
    });
  }

  try {
    const tokenHash = hashToken(token);
    const { rows } = await pool.query(
      `SELECT prt.user_id
         FROM password_reset_tokens prt
        WHERE prt.token_hash = $1
          AND prt.expires_at > now()
        LIMIT 1`,
      [tokenHash]
    );
    const found = rows[0];
    if (!found) return res.status(400).json({ error: 'Invalid or expired token' });

    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, found.user_id]);
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [found.user_id]);

    return res.json({ ok: true });
  } catch (e) {
    console.error('password/reset error:', e.message);
    return res.status(500).json({ error: 'Reset failed' });
  }
});

// Change password (must be signed in)
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword = '', newPassword = '' } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    // ✅ enforce strong-password rule
    if (!PASSWORD_RE.test(newPassword)) {
      return res.status(400).json({
        error:
          'New password must be at least 8 characters and include a letter, a number, and a special character.',
      });
    }

    const { rows } = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

    return res.json({ ok: true, message: 'Password changed' });
  } catch (err) {
    console.error('change-password failed:', err);
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

/**
 * GET /api/auth/test
 */
router.get('/test', (_req, res) => {
  res.json({ message: 'Auth route working' });
});

module.exports = router;
