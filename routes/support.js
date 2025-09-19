// routes/support.js
const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

const isEmail = (s = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// Build a transport that works for both 465(SSL) and 587(STARTTLS)
function makeTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    port === 465 ||
    String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true'; // explicit override if you want

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,            // e.g. smtp.hostinger.com
    port,
    secure,                                 // 465 => true, 587 => false
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    requireTLS: !secure,                    // request STARTTLS on 587
    tls: { minVersion: 'TLSv1.2' },         // harden TLS a bit
  });
}

router.post('/support', async (req, res) => {
  try {
    const {
      name = '',
      email = '',
      company = '',
      phone = '',
      subject = '',
      message = '',
      type = 'support',
    } = req.body || {};

    if (!isEmail(email) || !message.trim()) {
      return res.status(400).json({ error: 'Valid email and message are required.' });
    }

    const transporter = makeTransport();

    const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
    const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SMTP_USER;
    const MAILBOX = process.env.SMTP_USER; // ensure envelope uses your domain mailbox
    const prettyType = type === 'contact' ? 'Contact Us' : 'Support';

    // ---- Notify admin ----
    await transporter.sendMail({
      from: FROM_EMAIL,                     // header From (shown to recipient)
      sender: MAILBOX,                      // header Sender
      envelope: { from: MAILBOX, to: ADMIN_EMAIL }, // SMTP MAIL FROM / RCPT TO
      to: ADMIN_EMAIL,
      replyTo: email,
      subject: `📨 ${prettyType} — ${subject || '(no subject)'} — ${email}`,
      text: [
        `Type: ${prettyType}`,
        `Name: ${name}`,
        `Company: ${company}`,
        `Email: ${email}`,
        `Phone: ${phone}`,
        `Subject: ${subject}`,
        '',
        'Message:',
        message,
      ].join('\n'),
    });

    // ---- Auto-reply to the requester ----
    await transporter.sendMail({
      from: FROM_EMAIL,
      sender: MAILBOX,
      envelope: { from: MAILBOX, to: email },
      to: email,
      subject: `We received your ${prettyType.toLowerCase()} request`,
      text:
        `Hi${name ? ' ' + name : ''},\n\n` +
        `Thanks for reaching out. We received your ${prettyType.toLowerCase()} request and will respond as soon as possible.\n\n` +
        `— Printshopinvoice Support`,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('Support mail error:', e);
    res.status(500).json({ error: 'Could not send email right now.' });
  }
});

module.exports = router;
