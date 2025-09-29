const express = require('express');
const nodemailer = require('nodemailer');

const router = express.Router();

/* ── SMTP from env ──
  Expected on Render:
  SMTP_HOST=smtp.hostinger.com
  SMTP_PORT=587
  SMTP_SECURE=false
  SMTP_USER=support@printshopinvoice.com
  SMTP_PASS=********
  EMAIL_FROM="Print Shop Invoice App" <support@printshopinvoice.com>
  FROM_EMAIL=support@printshopinvoice.com
  SUPPORT_NOTIFY_TO=support@printshopinvoice.com
*/
const MAIL_FROM =
  process.env.EMAIL_FROM || '"Print Shop Invoice App" <support@printshopinvoice.com>';
const MAIL_SENDER =
  process.env.FROM_EMAIL || process.env.SMTP_USER || 'support@printshopinvoice.com';
const SUPPORT_NOTIFY_TO =
  process.env.SUPPORT_NOTIFY_TO || process.env.ADMIN_EMAIL || 'support@printshopinvoice.com';

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

  transporter.verify().then(
    () => console.log('✉️  SMTP (notify) ready'),
    (e) => console.warn('✉️  SMTP (notify) verify failed:', e?.message || e)
  );
}

async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.log('📭 SMTP not configured. Would have sent:', { to, subject });
    return;
  }
  await transporter.sendMail({
    from: MAIL_FROM,
    sender: MAIL_SENDER,
    envelope: { from: MAIL_SENDER, to },
    to,
    subject,
    text,
    html,
  });
}

/* Simple GET to test SMTP end-to-end */
router.get('/test', async (_req, res) => {
  try {
    await sendMail({
      to: SUPPORT_NOTIFY_TO,
      subject: 'SMTP test (/api/notify/test)',
      text: 'This is a test from /api/notify/test',
      html: '<p>This is a <strong>test</strong> from /api/notify/test</p>',
    });
    res.json({ ok: true, to: SUPPORT_NOTIFY_TO });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* POST /api/notify/signup { email, userId } */
router.post('/signup', express.json(), async (req, res) => {
  const { email, userId } = req.body || {};
  try {
    await sendMail({
      to: SUPPORT_NOTIFY_TO,
      subject: `🆕 New signup (manual notify): ${email || '(no email)'}`,
      text: `Email: ${email}\nUser ID: ${userId}\nTime: ${new Date().toISOString()}`,
      html: `<h2>New signup</h2>
             <p><strong>Email:</strong> ${email || '(no email)'}</p>
             <p><strong>User ID:</strong> ${userId || '(n/a)'}</p>
             <p><strong>Time (UTC):</strong> ${new Date().toISOString()}</p>`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* POST /api/notify/subscription { email, userId, status, priceId } */
router.post('/subscription', express.json(), async (req, res) => {
  const { email, userId, status, priceId } = req.body || {};
  try {
    await sendMail({
      to: SUPPORT_NOTIFY_TO,
      subject: `✅ Subscription notify: ${email || '(no email)'}${status ? ` (${status})` : ''}`,
      text: `Email: ${email}\nUser ID: ${userId}\nStatus: ${status}\nPrice ID: ${priceId}\nTime: ${new Date().toISOString()}`,
      html: `<h2>Subscription</h2>
             <p><strong>Email:</strong> ${email || '(no email)'}</p>
             <p><strong>User ID:</strong> ${userId || '(n/a)'}</p>
             <p><strong>Status:</strong> ${status || '(n/a)'}</p>
             <p><strong>Price ID:</strong> ${priceId || '(n/a)'}</p>
             <p><strong>Time (UTC):</strong> ${new Date().toISOString()}</p>`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
