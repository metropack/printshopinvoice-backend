// backend/utils/mailer.js
const nodemailer = require('nodemailer');

const host   = process.env.SMTP_HOST;
const port   = Number(process.env.SMTP_PORT || 587);
const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const user   = process.env.SMTP_USER;  // e.g. support@printshopinvoice.com
const pass   = process.env.SMTP_PASS;

const DEFAULT_FROM_EMAIL = process.env.MAIL_FROM || process.env.SMTP_FROM || user;
const DEFAULT_FROM_NAME  = process.env.MAIL_FROM_NAME || 'Print Shop Invoice';

if (!host || !user || !pass) {
  console.warn('[mailer] Missing SMTP env vars (SMTP_HOST/SMTP_USER/SMTP_PASS). Email will fail.');
}

const transporter = nodemailer.createTransport({
  host,
  port,
  secure,
  auth: { user, pass },
});

/**
 * sendMail({ to, subject, text, html, replyTo, attachments, from })
 * - `from` sets the *header* From (what recipients see)
 * - envelope MAIL FROM is forced to the SMTP user to satisfy providers
 */
async function sendMail({ to, subject, text, html, replyTo, attachments, from }) {
  // Header From (what shows to the recipient)
  const headerFrom =
    typeof from === 'string'
      ? from                                   // e.g. 'Receipts <receipts@printshopinvoice.com>'
      : (from?.email
          ? `${from.name ? from.name + ' ' : ''}<${from.email}>`
          : `${DEFAULT_FROM_NAME} <${DEFAULT_FROM_EMAIL}>`);

  const baseOpts = {
    from: headerFrom,          // header From
    sender: user,              // header Sender (helps DMARC in some setups)
    to,
    subject,
    text: text || (html ? html.replace(/<[^>]+>/g, '') : ''),
    html: html || (text ? `<p>${String(text).replace(/\n/g, '<br/>')}</p>` : '<p>(empty)</p>'),
    attachments: attachments || [],
    // Envelope: SMTP MAIL FROM / RCPT TO
    envelope: {
      from: user,              // MAIL FROM must be the authenticated account
      to: Array.isArray(to) ? to : [to],
    },
  };
  if (replyTo) baseOpts.replyTo = replyTo;

  try {
    return await transporter.sendMail(baseOpts);
  } catch (err) {
    // Some servers still reject if header From isn't owned by SMTP user.
    // Retry once with header From = SMTP user but keep Reply-To = original headerFrom
    const isSenderIssue =
      err?.code === 'EENVELOPE' ||
      /sender address rejected|not owned by user/i.test(String(err?.response || ''));

    if (isSenderIssue) {
      const retryOpts = {
        ...baseOpts,
        from: `${DEFAULT_FROM_NAME} <${user}>`,  // header From = support@
        replyTo: replyTo || headerFrom,          // replies still go to receipts@
      };
      return transporter.sendMail(retryOpts);
    }
    throw err;
  }
}

module.exports = { sendMail };
