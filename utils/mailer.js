// backend/utils/mailer.js
const nodemailer = require('nodemailer');

const host   = process.env.SMTP_HOST;
const port   = Number(process.env.SMTP_PORT || 587);
const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const user   = process.env.SMTP_USER;
const pass   = process.env.SMTP_PASS;
const from   = process.env.SMTP_FROM || user;

if (!host || !user || !pass) {
  // Don't crash, but log loudly so you see it in Render logs
  console.warn('[mailer] Missing SMTP env vars (SMTP_HOST/SMTP_USER/SMTP_PASS). Email will fail.');
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure, // true for 465, false for 587/STARTTLS
  auth: { user, pass },
});

async function sendMail({ to, subject, text, html, replyTo, attachments }) {
  const opts = {
    from,            // default sender
    to,
    subject,
    text: text || (html ? html.replace(/<[^>]+>/g, '') : ''),
    html: html || (text ? `<p>${String(text).replace(/\n/g, '<br/>')}</p>` : '<p>(empty)</p>'),
    attachments: attachments || [],
  };
  if (replyTo) opts.replyTo = replyTo;

  return transporter.sendMail(opts);
}

module.exports = { sendMail };
