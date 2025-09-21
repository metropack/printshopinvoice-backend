// routes/debugEmail.js
const express = require('express');
const nodemailer = require('nodemailer');

const router = express.Router();

function makeTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;

  if (!host) throw new Error('Missing SMTP_HOST');

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// GET /api/_debug/test-email?to=you@example.com
router.get('/test-email', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ error: 'Provide ?to=email@example.com' });

  try {
    const tx = makeTransporter();
    // Optional: verify SMTP connection first
    await tx.verify();

    const info = await tx.sendMail({
      from: process.env.FROM_EMAIL || 'no-reply@example.com',
      to,
      subject: 'Test email from Invoice App',
      text: 'If you can read this, SMTP is configured 🎉',
      html: '<p>If you can read this, SMTP is configured 🎉</p>',
    });

    res.json({ ok: true, messageId: info.messageId, to });
  } catch (err) {
    console.error('SMTP test failed:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
