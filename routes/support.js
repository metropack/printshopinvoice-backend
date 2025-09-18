// routes/support.js
const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

function isEmail(s=''){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()); }

router.post('/support', async (req, res) => {
  try {
    const { name='', email='', company='', phone='', subject='', message='', type='support' } = req.body || {};
    if (!isEmail(email) || !message.trim()) return res.status(400).json({ error:'Valid email and message are required.' });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
    const FROM_EMAIL  = process.env.FROM_EMAIL || process.env.SMTP_USER;
    const prettyType = type === 'contact' ? 'Contact Us' : 'Support';

    await transporter.sendMail({
      from: FROM_EMAIL,
      to: ADMIN_EMAIL,
      replyTo: email,
      subject: `📨 ${prettyType} — ${subject || '(no subject)'} — ${email}`,
      text: [
        `Type: ${prettyType}`,
        `Name: ${name}`, `Company: ${company}`, `Email: ${email}`, `Phone: ${phone}`,
        `Subject: ${subject}`, '', `Message:`, message
      ].join('\n'),
    });

    await transporter.sendMail({
      from: FROM_EMAIL,
      to: email,
      subject: `We received your ${prettyType.toLowerCase()} request`,
      text: `Hi${name ? ' ' + name : ''},\n\nThanks for reaching out. We received your ${prettyType.toLowerCase()} request and will respond as soon as possible.\n\n— MPS Inc Support`
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Support mail error:', e);
    res.status(500).json({ error: 'Could not send email right now.' });
  }
});

module.exports = router;
