// backend/routes/passwordReset.js
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const pool = require('../db');

const router = express.Router();

/* ───────────────────────── Config ───────────────────────── */
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
const RESET_PATH = process.env.RESET_PATH || '/reset.html'; // your page name (reset.html by default)
const RESET_TOKEN_TTL_HOURS = parseInt(process.env.RESET_TOKEN_TTL_HOURS || '2', 10);

// ≥8 chars, at least one letter, one number, one special char
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ───────────────────────── Mailer (Hostinger-friendly) ─────────────────────────
   Use:
     SMTP_HOST=smtp.hostinger.com
     SMTP_PORT=587
     SMTP_USER=support@printshopinvoice.com
     SMTP_PASS=********
     EMAIL_FROM="MPS Inc • Invoice App" <no-reply@printshopinvoice.com>   // alias
-------------------------------------------------------------------------- */
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

async function sendResetEmail(toEmail, link) {
  if (!transporter) {
    console.log('⚠️ SMTP not configured. Reset link:', link);
    return;
  }

  const headerFrom =
    process.env.EMAIL_FROM || '"Print Shop Invoice App" <no-reply@printshopinvoice.com>';

  // must match the authenticated mailbox (your real Hostinger mailbox)
  const sender = process.env.SMTP_USER || 'support@printshopinvoice.com';

  await transporter.sendMail({
    from: headerFrom,                 // shows as the From: alias in email clients
    sender,                           // Sender: header (auth mailbox)
    envelope: { from: sender, to: toEmail }, // SMTP MAIL FROM must be the real mailbox
    to: toEmail,
    subject: 'Reset your MPS Invoice App password',
    text: `Click to reset your password: ${link}\nThis link expires in ${RESET_TOKEN_TTL_HOURS} hour(s).`,
    html: `<p>Click to reset your password:</p>
           <p><a href="${link}">${link}</a></p>
           <p>This link expires in ${RESET_TOKEN_TTL_HOURS} hour(s).</p>`,
  });
}

/* ───────────────────────── Helpers ───────────────────────── */
async function createResetRecordForUser(emailLower) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE lower(email) = $1',
    [emailLower]
  );
  const userId = rows[0]?.id;
  if (!userId) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (token_hash) DO NOTHING`,
    [userId, tokenHash, expiresAt]
  );

  return token;
}

/* ───────────────────────── Routes ───────────────────────── */
/** Request reset email (both paths supported) */
async function requestResetHandler(req, res) {
  const { email = '' } = req.body || {};
  const normalized = String(email).trim().toLowerCase();

  try {
    const token = await createResetRecordForUser(normalized);
    if (token) {
      const base = FRONTEND_URL; // already trimmed
      const link = `${base}${RESET_PATH}?token=${token}`;
      try {
        await sendResetEmail(normalized, link);
      } catch (e) {
        console.error('sendMail error:', e);
        // Still return success to avoid enumeration / UX issues
      }
    }
  } catch (err) {
    console.error('request-password-reset error:', err);
    // Do not reveal details
  }

  // Always return ok to avoid email enumeration
  return res.json({ ok: true, message: 'If that email exists, we sent a reset link.' });
}

router.post('/request-password-reset', requestResetHandler);
router.post('/password/forgot', requestResetHandler); // compatibility with your reset.html

/** Submit new password (both paths supported) */
async function resetPasswordHandler(req, res) {
  const { token = '', password = '' } = req.body || {};

  if (!token || !PASSWORD_RE.test(password)) {
    return res.status(400).json({
      error:
        'Invalid request. Password must be at least 8 characters and include a letter, a number, and a special character.',
    });
  }

  const tokenHash = hashToken(token);

  try {
    const { rows } = await pool.query(
      `SELECT pr.id, pr.user_id
         FROM password_resets pr
        WHERE pr.token_hash = $1
          AND pr.used = false
          AND pr.expires_at > NOW()
        LIMIT 1`,
      [tokenHash]
    );

    const row = rows[0];
    if (!row) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const pwdHash = await bcrypt.hash(password, 10);

    // Update user password + mark token used
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [pwdHash, row.user_id]);
    await pool.query('UPDATE password_resets SET used = true WHERE id = $1', [row.id]);

    return res.json({ ok: true, message: 'Password updated' });
  } catch (err) {
    console.error('reset-password error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

router.post('/reset-password', resetPasswordHandler);
router.post('/password/reset', resetPasswordHandler); // compatibility with your reset.html

module.exports = router;
