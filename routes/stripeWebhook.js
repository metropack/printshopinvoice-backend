// backend/routes/stripeWebhook.js
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const pool = require('../db');

const router = express.Router();

/* ───────────────────────── Stripe ───────────────────────── */
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Raw body ONLY for this route
const rawBody = express.raw({ type: 'application/json' });

/* For links in customer emails */
const FRONTEND =
  (process.env.FRONTEND_URL || 'https://printshopinvoice.com').replace(/\/$/, '');

/* ───────────────────────── Mail (Hostinger SMTP) ───────────────────────── */
const MAIL_FROM =
  process.env.EMAIL_FROM || '"Print Shop Invoice App" <support@printshopinvoice.com>'; // what recipients see
const MAIL_SENDER =
  process.env.FROM_EMAIL || process.env.SMTP_USER || 'support@printshopinvoice.com'; // envelope sender
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

  // Non-fatal verification log
  transporter.verify().then(
    () => console.log('✉️  SMTP (webhook) ready'),
    (e) => console.warn('✉️  SMTP (webhook) verify failed:', e?.message || e)
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

// Admin email
async function notifySupport({ title, email, userId, status, priceId, extra }) {
  const subject = `${title}: ${email || '(no email)'}${status ? ` (${status})` : ''}`;
  const time = new Date().toISOString();
  const text =
    `${title}\n` +
    (email ? `Email: ${email}\n` : '') +
    (userId ? `User ID: ${userId}\n` : '') +
    (status ? `Status: ${status}\n` : '') +
    (priceId ? `Price ID: ${priceId}\n` : '') +
    `Time (UTC): ${time}\n` +
    (extra ? `Extra: ${extra}\n` : '');
  const html = `
    <h2>${title}</h2>
    ${email ? `<p><strong>Email:</strong> ${email}</p>` : ''}
    ${userId ? `<p><strong>User ID:</strong> ${userId}</p>` : ''}
    ${status ? `<p><strong>Status:</strong> ${status}</p>` : ''}
    ${priceId ? `<p><strong>Price ID:</strong> ${priceId}</p>` : ''}
    <p><strong>Time (UTC):</strong> ${time}</p>
    ${extra ? `<pre>${String(extra)}</pre>` : ''}
  `;
  try {
    await sendMail({ to: SUPPORT_NOTIFY_TO, subject, text, html });
  } catch (e) {
    console.warn('notifySupport failed:', e?.message || e);
  }
}

// Customer email
async function notifyCustomer({ to, subject, text, html }) {
  if (!to) return;
  try {
    await sendMail({ to, subject, text, html });
  } catch (e) {
    console.warn('notifyCustomer failed:', e?.message || e);
  }
}

/* ───────────────────────── DB helpers ───────────────────────── */
async function findUserById(id) {
  const r = await pool.query('SELECT id, email FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function findUserByEmail(email) {
  const r = await pool.query('SELECT id, email FROM users WHERE lower(email)=lower($1)', [email]);
  return r.rows[0] || null;
}
async function findUserByCustomerId(cusId) {
  const r = await pool.query('SELECT id, email FROM users WHERE stripe_customer_id=$1', [cusId]);
  return r.rows[0] || null;
}

/** Try to resolve an email for a Stripe customer id (DB first, then Stripe). */
async function resolveEmailForCustomer(customerId) {
  if (!customerId) return null;
  const byDb = await findUserByCustomerId(customerId);
  if (byDb?.email) return byDb.email;
  try {
    const c = await stripe.customers.retrieve(customerId);
    return (c?.email || '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/* ───────────────────────── Webhook route ───────────────────────── */
router.post('/stripe/webhook', rawBody, async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  // 1) Verify signature
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      /**
       * After successful Checkout:
       * - set subscription_status = 'active'
       * - store stripe_customer_id (cus_...)
       * - store stripe_subscription_id (sub_...)
       * - notify support
       *
       * We keep customer welcome email in `customer.subscription.created`
       * to avoid double emails.
       */
      case 'checkout.session.completed': {
        const s = event.data.object;

        const userIdRaw = s.client_reference_id || (s.metadata && s.metadata.userId);
        const userId =
          userIdRaw && /^\d+$/.test(String(userIdRaw)) ? Number(userIdRaw) : null;

        const customerId = s.customer || null;         // cus_...
        const subscriptionId = s.subscription || null; // sub_...
        const email = (s.customer_details?.email || s.customer_email || '').toLowerCase();
        const priceId =
          (s.line_items && s.line_items[0] && s.line_items[0].price && s.line_items[0].price.id) ||
          (s.metadata && s.metadata.price) ||
          null;

        let rowUser = null;
        let updated = 0;

        if (userId) {
          const r = await pool.query(
            `UPDATE users
                SET subscription_status    = 'active',
                    stripe_customer_id     = COALESCE(stripe_customer_id, $2),
                    stripe_subscription_id = $3
              WHERE id = $1`,
            [userId, customerId, subscriptionId]
          );
          updated = r.rowCount;
          rowUser = await findUserById(userId);
        }

        if (!updated && customerId) {
          const r2 = await pool.query(
            `UPDATE users
                SET subscription_status    = 'active',
                    stripe_subscription_id = $2
              WHERE stripe_customer_id = $1`,
            [customerId, subscriptionId]
          );
          updated = r2.rowCount;
          if (!rowUser) rowUser = await findUserByCustomerId(customerId);
        }

        if (!updated && email) {
          await pool.query(
            `UPDATE users
                SET subscription_status    = 'active',
                    stripe_customer_id     = COALESCE(stripe_customer_id, $2),
                    stripe_subscription_id = $3
              WHERE lower(email) = lower($1)`,
            [email, customerId, subscriptionId]
          );
          if (!rowUser) rowUser = await findUserByEmail(email);
        }

        await notifySupport({
          title: '✅ Subscription checkout completed',
          email: rowUser?.email || email,
          userId: rowUser?.id,
          status: 'active',
          priceId,
          extra: `customer=${customerId} subscription=${subscriptionId}`
        });

        break;
      }

      /**
       * Keep DB in sync when the subscription changes.
       * Collapse to active/inactive for app logic and notify on important changes.
       * Also email the *customer* when the subscription is first created (welcome/trial).
       */
      case 'customer.subscription.created': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const status = sub.status; // trialing | active | ...
        const priceId = sub.items?.data?.[0]?.price?.id;

        // Try to resolve user/email
        let user = await findUserByCustomerId(customerId);
        let email = user?.email;

        if (!email) {
          try {
            const customer = await stripe.customers.retrieve(customerId);
            email = (customer.email || '').toLowerCase();
            if (!user && email) user = await findUserByEmail(email);
          } catch (_) {}
        }

        const newStatus =
          status === 'active' || status === 'trialing' ? 'active' : 'inactive';

        await pool.query(
          `UPDATE users
              SET subscription_status    = $2,
                  stripe_subscription_id = $3
            WHERE stripe_customer_id = $1`,
          [customerId, newStatus, sub.id]
        );

        await notifySupport({
          title: '🆕 Subscription created',
          email,
          userId: user?.id,
          status: newStatus,
          priceId,
          extra: `customer=${customerId} subscription=${sub.id}`
        });

        // 👇 Customer welcome / trial-start email
        const trialEnds = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
        const trialText = trialEnds
          ? `Your free trial has started and will end on ${trialEnds.toLocaleString()}. `
          : '';
        const billingText = `You can manage your subscription from your account page.`;

        await notifyCustomer({
          to: email,
          subject: trialEnds
            ? 'Welcome! Your free trial has started'
            : 'Welcome! Your subscription is active',
          text:
            (trialText || 'Your subscription is active. ') +
            billingText +
            ` ${FRONTEND}/account.html`,
          html: `
            <p>Hi,</p>
            <p>${trialText || 'Your subscription is now <strong>active</strong>.'}</p>
            <p>${billingText} <a href="${FRONTEND}/account.html">Open your account</a>.</p>
            <p>— Print Shop Invoice App</p>
          `
        });

        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const status = sub.status;
        const priceId = sub.items?.data?.[0]?.price?.id;

        const newStatus =
          status === 'active' || status === 'trialing' ? 'active' : 'inactive';

        await pool.query(
          `UPDATE users
              SET subscription_status    = $2,
                  stripe_subscription_id = $3
            WHERE stripe_customer_id = $1`,
          [customerId, newStatus, sub.id]
        );

        await notifySupport({
          title: '🔄 Subscription updated',
          email: (await findUserByCustomerId(customerId))?.email,
          status: newStatus,
          priceId,
          extra: `customer=${customerId} subscription=${sub.id}`
        });

        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;

        await pool.query(
          `UPDATE users
              SET subscription_status = 'inactive',
                  stripe_subscription_id = NULL
            WHERE stripe_customer_id = $1
               OR stripe_subscription_id = $2`,
          [customerId, sub.id]
        );

        const user = await findUserByCustomerId(customerId);
        const email = user?.email || (await resolveEmailForCustomer(customerId));

        await notifySupport({
          title: '❌ Subscription canceled',
          email,
          status: 'inactive',
          priceId: sub.items?.data?.[0]?.price?.id,
          extra: `customer=${customerId} subscription=${sub.id}`
        });

        // 👇 Customer email
        await notifyCustomer({
          to: email,
          subject: 'Your subscription has been canceled',
          text:
            'Your subscription has been canceled and will not renew. ' +
            'If this was a mistake, you can restart your subscription from your account page.',
          html: `
            <p>Hi,</p>
            <p>Your subscription has been <strong>canceled</strong> and will not renew.</p>
            <p>If this was a mistake, you can restart from your <a href="${FRONTEND}/account.html">account page</a>.</p>
            <p>— Print Shop Invoice App</p>
          `
        });

        break;
      }

      /**
       * Optional: mark inactive on failed payment, active on success.
       */
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const customerId = inv.customer;
        await pool.query(
          `UPDATE users SET subscription_status='inactive'
            WHERE stripe_customer_id=$1`,
          [customerId]
        );

        const email =
          (await findUserByCustomerId(customerId))?.email ||
          (inv.customer_email || '').toLowerCase() ||
          (await resolveEmailForCustomer(customerId));

        await notifySupport({
          title: '⚠️ Payment failed',
          email,
          status: 'inactive',
          priceId: inv.lines?.data?.[0]?.price?.id,
          extra: `invoice=${inv.id} customer=${customerId}`
        });

        // 👇 Customer email
        await notifyCustomer({
          to: email,
          subject: 'Payment failed — action needed',
          text:
            'Your recent payment failed. Please update your card to keep your subscription active: ' +
            `${FRONTEND}/account.html`,
          html: `
            <p>Hi,</p>
            <p>Your recent payment <strong>failed</strong>. Please update your card to keep your subscription active.</p>
            <p><a href="${FRONTEND}/account.html">Manage your billing</a></p>
            <p>— Print Shop Invoice App</p>
          `
        });

        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const customerId = inv.customer;
        await pool.query(
          `UPDATE users SET subscription_status='active'
            WHERE stripe_customer_id=$1`,
          [customerId]
        );

        const email =
          (await findUserByCustomerId(customerId))?.email ||
          (inv.customer_email || '').toLowerCase() ||
          (await resolveEmailForCustomer(customerId));

        await notifySupport({
          title: '💸 Payment succeeded',
          email,
          status: 'active',
          priceId: inv.lines?.data?.[0]?.price?.id,
          extra: `invoice=${inv.id} customer=${customerId}`
        });

        // 👇 Customer email
        const amountDue =
          typeof inv.amount_paid === 'number'
            ? (inv.amount_paid / 100).toFixed(2) + ' ' + (inv.currency || '').toUpperCase()
            : null;

        await notifyCustomer({
          to: email,
          subject: 'Payment received — thank you',
          text:
            `Your payment was successful.` +
            (amountDue ? ` Amount: ${amountDue}.` : '') +
            ` You can view invoices from your account page.`,
          html: `
            <p>Hi,</p>
            <p>Your payment was <strong>successful</strong>${amountDue ? ` (Amount: <strong>${amountDue}</strong>)` : ''}.</p>
            <p>You can view or download your invoices from your <a href="${FRONTEND}/account.html">account page</a>.</p>
            <p>— Print Shop Invoice App</p>
          `
        });

        break;
      }

      /* ────────────────── Optional newer event ────────────────── */
      case 'invoice_payment.paid': {
        // Newer event when an invoice payment is successful (some API versions)
        const inpay = event.data.object; // type "invoice_payment"
        const invoiceId = inpay.invoice;
        let customerId = (inpay.payment && inpay.payment.customer) || inpay.customer || null;

        // Fallback: fetch invoice to get the customer id
        if (!customerId && invoiceId) {
          try {
            const inv = await stripe.invoices.retrieve(invoiceId);
            customerId = inv.customer || null;
          } catch (_) {}
        }

        // Mark the user as active for that customer
        if (customerId) {
          await pool.query(
            `UPDATE users SET subscription_status='active'
              WHERE stripe_customer_id=$1`,
            [customerId]
          );
        }

        // Try to include a price id from the invoice and email
        let priceId = null;
        let email = null;
        try {
          if (invoiceId) {
            const inv = await stripe.invoices.retrieve(invoiceId);
            priceId = inv?.lines?.data?.[0]?.price?.id || null;
            email =
              (await findUserByCustomerId(inv.customer))?.email ||
              (inv.customer_email || '').toLowerCase() ||
              (await resolveEmailForCustomer(inv.customer));
          }
        } catch (_) {}

        await notifySupport({
          title: '💸 Invoice payment (invoice_payment.paid)',
          email,
          status: 'active',
          priceId,
          extra: `invoice=${invoiceId} customer=${customerId}`
        });

        await notifyCustomer({
          to: email,
          subject: 'Payment received — thank you',
          text:
            'Your payment was successful. You can view invoices from your account page.',
          html: `
            <p>Hi,</p>
            <p>Your payment was <strong>successful</strong>.</p>
            <p>You can view invoices from your <a href="${FRONTEND}/account.html">account page</a>.</p>
            <p>— Print Shop Invoice App</p>
          `
        });

        break;
      }
      /* ────────────────────────────────────────────────────────── */

      default:
        // No-op for other events
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler failed:', err);
    return res.status(500).send('Webhook handler error');
  }
});

module.exports = router;
