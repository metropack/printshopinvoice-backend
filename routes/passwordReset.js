// backend/routes/passwordReset.js
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const pool = require('../db');

const router = express.Router();

// Use env in production; local fallback for dev
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const RESET_TOKEN_TTL_HOURS = parseInt(process.env.RESET_TOKEN_TTL_HOURS || '2', 10);

// Strong password rule: ≥8 chars, at least one letter, one number, one special character
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Optional SMTP transporter
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

// POST /api/auth/request-password-reset
router.post('/request-password-reset', async (req, res) => {
  const { email = '' } = req.body;
  const normalized = String(email).trim().toLowerCase();

  // Always respond 200 to avoid email enumeration
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE lower(email) = $1',
      [normalized]
    );
    const userId = rows[0]?.id;

    if (userId) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

      await pool.query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (token_hash) DO NOTHING`,
        [userId, tokenHash, expiresAt]
      );

      const link = `${FRONTEND_URL}/new-password.html?token=${token}`;

      if (transporter) {
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || 'no-reply@mpsinc.com',
          to: normalized,
          subject: 'Reset your MPS Invoice App password',
          text: `Click to reset your password: ${link}\nThis link expires in ${RESET_TOKEN_TTL_HOURS} hour(s).`,
          html: `<p>Click to reset your password:</p>
                 <p><a href="${link}">${link}</a></p>
                 <p>This link expires in ${RESET_TOKEN_TTL_HOURS} hour(s).</p>`,
        });
      } else {
        console.log('⚠️ SMTP not configured. Reset link:', link);
      }
    }
  } catch (err) {
    console.error('request-password-reset error:', err);
  }

  return res.json({ ok: true, message: 'If that email exists, we sent a reset link.' });
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token = '', password = '' } = req.body;

  // Enforce strong password here
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
    if (!row) return res.status(400).json({ error: 'Invalid or expired token' });

    const pwdHash = await bcrypt.hash(password, 10);

    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [pwdHash, row.user_id]);
    await pool.query('UPDATE password_resets SET used = true WHERE id = $1', [row.id]);

    return res.json({ ok: true, message: 'Password updated' });
  } catch (err) {
    console.error('reset-password error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
