// backend/routes/authRoutes.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const router = express.Router();

// shared DB pool
const pool = require('../db');

// optional seeding util
const { copyDefaultVariationsToUser } = require('../middleware/utils/seedUtils');

// auth middleware (for /me and billing ops)
const authenticate = require('../middleware/authenticate');

// ====== ENV ======
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// --- Mail settings (SMTP via Hostinger or similar) ---
const MAIL_FROM =
  process.env.EMAIL_FROM || '"Print Shop Invoice App" <support@printshopinvoice.com>'; // what recipients see
const MAIL_SENDER =
  process.env.FROM_EMAIL || process.env.SMTP_USER || 'support@printshopinvoice.com'; // envelope/sender
const SUPPORT_NOTIFY_TO =
  process.env.SUPPORT_NOTIFY_TO || process.env.ADMIN_EMAIL || 'support@printshopinvoice.com';

// Optional SMTP transporter
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure:
      String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' ||
      Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  // log verify result once at boot (non-fatal if it fails)
  transporter.verify().then(
    () => console.log('✉️  SMTP ready'),
    (e) => console.warn('✉️  SMTP verify failed:', e?.message || e)
  );
}

// Helper: send an email using transporter (logs if SMTP not set)
async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log('📭 SMTP not configured. Would have sent:', { to, subject });
    return;
  }
  await transporter.sendMail({
    from: MAIL_FROM,
    sender: MAIL_SENDER, // satisfies SMTP "owned mailbox" rules
    envelope: { from: MAIL_SENDER, to },
    to,
    subject,
    text,
    html,
  });
}

// ------------ Signup notification ------------
async function notifySupportSignup({ userId, email }) {
  const subject = `🆕 New signup: ${email}`;
  const text =
    `New user signed up\n` +
    `Email: ${email}\n` +
    `User ID: ${userId}\n` +
    `Time (UTC): ${new Date().toISOString()}\n`;
  const html = `
    <h2>New user signed up</h2>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>User ID:</strong> ${userId}</p>
    <p><strong>Time (UTC):</strong> ${new Date().toISOString()}</p>
  `;
  try {
    await sendMail({ to: SUPPORT_NOTIFY_TO, subject, text, html });
  } catch (e) {
    console.warn('notifySupportSignup failed:', e?.message || e);
  }
}

// ------------ Subscription notification ------------
async function notifySupportSubscribed({ userId, email, status, priceId }) {
  const subject = `✅ Subscription started: ${email} (${status})`;
  const text =
    `A user started a subscription\n` +
    `Email: ${email}\n` +
    `User ID: ${userId}\n` +
    `Status: ${status}\n` +
    `Price ID: ${priceId || '(n/a)'}\n` +
    `Time (UTC): ${new Date().toISOString()}\n`;
  const html = `
    <h2>Subscription started</h2>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>User ID:</strong> ${userId}</p>
    <p><strong>Status:</strong> ${status}</p>
    <p><strong>Price ID:</strong> ${priceId || '(n/a)'}</p>
    <p><strong>Time (UTC):</strong> ${new Date().toISOString()}</p>
  `;
  try {
    await sendMail({ to: SUPPORT_NOTIFY_TO, subject, text, html });
  } catch (e) {
    console.warn('notifySupportSubscribed failed:', e?.message || e);
  }
}

// ---- helpers for password reset ----
function makeToken() {
  return crypto.randomBytes(32).toString('hex'); // plaintext token (emailed)
}
function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex'); // stored hash
}
async function sendResetEmail(to, link) {
  const subject = 'Reset your MPS Invoice App password';
  const text =
    'We received a request to reset your password.\n' +
    `Open this link to reset: ${link}\n` +
    'If you didn’t request this, you can ignore this email. This link expires in 60 minutes.';
  const html = `
    <p>We received a request to reset your password.</p>
    <p><a href="${link}">Click here to reset your password</a></p>
    <p>If you didn’t request this, you can ignore this email.</p>
    <p>This link expires in 60 minutes.</p>
  `;
  await sendMail({ to, subject, text, html });
}

// 🔐 Password policy: ≥8 chars, at least 1 letter, 1 number, 1 special char
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

/**
 * POST /api/auth/register
 */
router.post('/register', async (req, res) => {
  const { email = '', password = '' } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

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

    try { await copyDefaultVariationsToUser(userId); } catch (_) {}

    // fire-and-forget support email
    notifySupportSignup({ userId, email });

    const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '7d' });
    return res.status(201).json({ message: 'Registered successfully', userId, token });
  } catch (err) {
    console.error('Register failed:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
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
 */
router.post('/create-checkout-session', async (req, res) => {
  if (!stripe) {
    console.error('Stripe not configured: missing STRIPE_SECRET_KEY');
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const PRICE_ID = process.env.STRIPE_PRICE_ID;
  const FRONTEND_URL_ENV = process.env.FRONTEND_URL || 'https://mps-site-rouge.vercel.app';

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
      subscription_data: {
        trial_period_days: 1,
      },
      client_reference_id: userIdForSession ? String(userIdForSession) : undefined,
      metadata: userIdForSession ? { userId: String(userIdForSession) } : undefined,
      success_url: `${FRONTEND_URL_ENV}/success.html`,
      cancel_url: `${FRONTEND_URL_ENV}/cancel.html`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error(
      'create-checkout-session error:',
      err?.type || 'no-type',
      err?.message || err?.raw?.message || '(no message)',
      'price:',
      (process.env.STRIPE_PRICE_ID || '').slice(0, 10) + '…',
      'key mode:',
      (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_') ? 'LIVE' : 'TEST'
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
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/auth/password/forgot { email }
 */
router.post('/password/forgot', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(email)=$1', [email]);
    const user = rows[0];

    // Always pretend success
    if (!user) return res.json({ ok: true });

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
    if (!PASSWORD_RE.test(newPassword)) {
      return res.status(400).json({
        error:
          'New password must be at least 8 characters and include a letter, a number, and a special character.',
      });
    }

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [
      req.user.id,
    ]);
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

// ---------- Diagnostics: test email ----------
router.get('/test-mail', async (_req, res) => {
  try {
    await sendMail({
      to: SUPPORT_NOTIFY_TO,
      subject: 'SMTP test from Print Shop Invoice backend',
      text: 'This is a test email from your Render service.',
      html: '<p>This is a <strong>test email</strong> from your Render service.</p>',
    });
    res.json({ ok: true, to: SUPPORT_NOTIFY_TO });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * NEW: POST /api/billing/resume
 * Clear, user-friendly messages for the Resume Subscription action.
 * (Added to fix vague “Unable to resume subscription” alerts.)
 */
router.post('/billing/resume', authenticate, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured.' });

  try {
    // We keep the query explicit so it works even if these columns are nullable.
    const { rows } = await pool.query(
      `SELECT id, email, subscription_status, stripe_subscription_id
         FROM users
        WHERE id = $1`,
      [req.user.id]
    );
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'User not found.' });

    if (!u.stripe_subscription_id) {
      return res.status(400).json({
        error:
          'No Stripe subscription on file to resume. Please start a new checkout from “Manage payment / billing”.',
      });
    }

    // Check current state at Stripe
    let sub = await stripe.subscriptions.retrieve(u.stripe_subscription_id);

    // Fully canceled or expired subscriptions cannot be resumed
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired' || sub.canceled_at) {
      return res.status(400).json({
        error:
          'This subscription is fully canceled and cannot be resumed. Start a new checkout from “Manage payment / billing”.',
      });
    }

    // Already active and not set to cancel at period end – treat as success (idempotent)
    if ((sub.status === 'active' || sub.status === 'trialing') && sub.cancel_at_period_end === false) {
      await pool.query(`UPDATE users SET subscription_status='active' WHERE id=$1`, [u.id]);
      return res.json({ ok: true, info: 'Subscription is already active.' });
    }

    // Resume by unsetting cancel_at_period_end
    sub = await stripe.subscriptions.update(u.stripe_subscription_id, {
      cancel_at_period_end: false,
    });

    const newStatus = (sub.status === 'active' || sub.status === 'trialing') ? 'active' : 'inactive';
    await pool.query(`UPDATE users SET subscription_status=$2 WHERE id=$1`, [u.id, newStatus]);

    return res.json({ ok: true });
  } catch (e) {
    // Provide a clear, human message
    const msg =
      e?.message ||
      'Could not resume subscription right now. Please try again or use “Manage payment / billing”.';
    return res.status(400).json({ error: msg });
  }
});

/**
 * Stripe webhook handler (exported)
 * We handle:
 *  - checkout.session.completed  → look up user, mark trialing/active, notify
 *  - customer.subscription.created / updated → track status changes, notify on created
 */
async function stripeWebhook(req, res) {
  if (!stripe) return res.status(500).send('Stripe not configured');

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body); // for local testing without signature
  } catch (err) {
    console.error('❌ Webhook signature verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = (session.customer_email || '').toLowerCase();
      const priceId = session?.line_items?.[0]?.price?.id || session?.metadata?.price || null;

      // userId from client_reference_id if you set it
      const hintedUserId = session.client_reference_id ? Number(session.client_reference_id) : null;

      let userRow = null;
      if (hintedUserId) {
        const { rows } = await pool.query('SELECT id, email FROM users WHERE id=$1', [hintedUserId]);
        userRow = rows[0] || null;
      } else if (email) {
        const { rows } = await pool.query('SELECT id, email FROM users WHERE lower(email)=lower($1)', [email]);
        userRow = rows[0] || null;
      }

      if (userRow) {
        // mark trialing (Stripe default) or active
        await pool.query(
          'UPDATE users SET subscription_status=$1 WHERE id=$2',
          [session.status === 'complete' ? 'trialing' : 'active', userRow.id]
        );
        await notifySupportSubscribed({
          userId: userRow.id,
          email: userRow.email || email,
          status: 'trialing',
          priceId: priceId || process.env.STRIPE_PRICE_ID
        });
      } else {
        console.warn('Webhook: could not match user for session', session.id, email);
      }
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const status = sub.status; // trialing, active, past_due, canceled, etc.
      const priceId = sub.items?.data?.[0]?.price?.id;

      // Find user by email via customer -> invoice settings if available (fallback none)
      let email = sub.customer_email || sub.customer_details?.email;
      // You can also store Stripe customer id in your DB and join here

      if (email) {
        const { rows } = await pool.query('SELECT id, email FROM users WHERE lower(email)=lower($1)', [email]);
        const userRow = rows[0];
        if (userRow) {
          await pool.query('UPDATE users SET subscription_status=$1 WHERE id=$2', [status, userRow.id]);
          if (event.type === 'customer.subscription.created') {
            await notifySupportSubscribed({ userId: userRow.id, email, status, priceId });
          }
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Webhook handler error:', e);
    res.status(500).send('Server error');
  }
}

module.exports = { router, stripeWebhook };
