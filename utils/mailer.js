// backend/utils/mailer.js
const nodemailer = require('nodemailer');

const host   = process.env.SMTP_HOST;
const port   = Number(process.env.SMTP_PORT || 587);
const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const user   = process.env.SMTP_USER;
const pass   = process.env.SMTP_PASS;

// Prefer explicit MAIL_FROM / NAME, then SMTP_FROM, then the SMTP user.
const DEFAULT_FROM_EMAIL = process.env.MAIL_FROM || process.env.SMTP_FROM || user;
const DEFAULT_FROM_NAME  = process.env.MAIL_FROM_NAME || 'Print Shop Invoice';

if (!host || !user || !pass) {
  console.warn('[mailer] Missing SMTP env vars (SMTP_HOST/SMTP_USER/SMTP_PASS). Email will fail.');
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure, // true for 465, false for 587/STARTTLS
  auth: { user, pass },
});

/**
 * sendMail
 * - accepts `from` to override default envelope
 * - keeps `sender` as the authenticated account to satisfy DMARC if needed
 */
async function sendMail({ to, subject, text, html, replyTo, attachments, from }) {
  const fromValue =
    typeof from === 'string'
      ? from // e.g. 'Receipts <receipts@printshopinvoice.com>'
      : (from?.email
          ? `${from.name ? from.name + ' ' : ''}<${from.email}>`
          : `${DEFAULT_FROM_NAME} <${DEFAULT_FROM_EMAIL}>`);

  const opts = {
    from: fromValue,
    sender: user, // helpful for some providers/DMARC
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
