// backend/routes/billing.js
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const pool = require('../db');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Use your real website; allow ENV override; strip trailing slash.
const FRONTEND = (process.env.FRONTEND_URL || 'https://printshopinvoice.com').replace(/\/$/, '');

/* ───────────────────────── Mail (Hostinger SMTP) ───────────────────────── */
const MAIL_FROM =
  process.env.EMAIL_FROM || '"Print Shop Invoice App" <support@printshopinvoice.com>'; // what recipients see
const MAIL_SENDER =
  process.env.FROM_EMAIL || process.env.SMTP_USER || 'support@printshopinvoice.com';   // envelope sender
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
    () => console.log('✉️  SMTP (billing) ready'),
    (e) => console.warn('✉️  SMTP (billing) verify failed:', e?.message || e)
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

async function emailAdmin(subject, bodyHtml, bodyText) {
  await sendMail({
    to: SUPPORT_NOTIFY_TO,
    subject,
    text: bodyText || bodyHtml?.replace(/<[^>]+>/g, '') || '',
    html: bodyHtml || `<p>${bodyText || ''}</p>`
  });
}

async function emailCustomer(to, subject, bodyHtml, bodyText) {
  if (!to) return;
  await sendMail({
    to,
    subject,
    text: bodyText || bodyHtml?.replace(/<[^>]+>/g, '') || '',
    html: bodyHtml || `<p>${bodyText || ''}</p>`
  });
}

/**
 * POST /api/billing/checkout/start
 * (unchanged)
 */
router.post('/checkout/start', async (req, res) => {
  try {
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(500).json({ error: 'Missing STRIPE_PRICE_ID in environment' });

    const userId = req.user?.id || null;
    let email = (req.body?.email || '').trim().toLowerCase() || null;

    // If authenticated but no email passed, load from DB
    if (userId && !email) {
      const r = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      email = r.rows[0]?.email || null;
    }

    // Prepare (or find) a customer by email
    let customerId = null;
    if (email) {
      const list = await stripe.customers.list({ email, limit: 1 });
      customerId = list.data[0]?.id || null;
      if (!customerId) {
        const c = await stripe.customers.create({ email });
        customerId = c.id;
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],

      // ✅ After successful payment, go to your website login with the paid banner
      success_url: `${FRONTEND}/login.html?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      // Optional cancel fallback
      cancel_url: `${FRONTEND}/signup.html?canceled=1`,

      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      ...(customerId ? { customer: customerId } : {}),
      ...(userId ? { client_reference_id: String(userId) } : {}),
    });

    console.log('✅ Checkout created. Success URL:', session.success_url);
    return res.json({ url: session.url });
  } catch (err) {
    console.error('billing/checkout/start error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to start checkout' });
  }
});

/**
 * GET /api/billing/status
 * (unchanged)
 */
router.get('/status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, stripe_customer_id, subscription_status FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });

    let { email, stripe_customer_id: customerId, subscription_status } = row;

    // Try to recover a missing customer id by email (current Stripe account/mode)
    if (!customerId) {
      const list = await stripe.customers.list({ email, limit: 1 });
      customerId = list.data[0]?.id || null;
      if (customerId) {
        await pool.query(
          'UPDATE users SET stripe_customer_id = $2 WHERE id = $1',
          [req.user.id, customerId]
        );
      }
    }

    // Default response if we can't reach Stripe / no sub
    let response = {
      subscription_status: subscription_status || 'inactive',
      cancel_at_period_end: false,
      current_period_end: null,
    };

    if (customerId) {
      const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
      const sub = subs.data[0];
      if (sub) {
        const isActive = sub.status === 'active' || sub.status === 'trialing';
        response = {
          subscription_status: isActive ? 'active' : 'inactive',
          cancel_at_period_end: sub.cancel_at_period_end,
          current_period_end: sub.current_period_end, // unix seconds
        };
        // keep DB in sync
        await pool.query(
          'UPDATE users SET subscription_status = $2 WHERE id = $1',
          [req.user.id, response.subscription_status]
        );
      }
    }

    return res.json(response);
  } catch (err) {
    console.error('billing/status error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to load status' });
  }
});

/**
 * POST /api/billing/portal
 * (unchanged)
 */
router.post('/portal', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });

    const email = row.email;
    let customerId = row.stripe_customer_id;

    // If missing, try to find in the current Stripe account/mode by email
    if (!customerId) {
      const list = await stripe.customers.list({ email, limit: 1 });
      customerId = list.data[0]?.id || null;
      if (!customerId) {
        console.error('billing/portal: no Stripe customer for', email);
        return res.status(400).json({ error: 'No Stripe customer on file' });
      }
      await pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [req.user.id, customerId]);
    }

    // Sanity check: if this ID is from the wrong Stripe account/mode, fix it by email
    try {
      await stripe.customers.retrieve(customerId);
    } catch (e) {
      console.error('billing/portal retrieve failed:', e?.message || e);
      const list = await stripe.customers.list({ email, limit: 1 });
      const found = list.data[0]?.id;
      if (!found) return res.status(400).json({ error: 'Stripe customer not found for this account/mode' });
      if (found !== customerId) {
        customerId = found;
        await pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [req.user.id, customerId]);
      }
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND}/account.html`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('billing/portal error:', {
      message: err?.message,
      code: err?.code,
      type: err?.type,
      raw: err?.raw?.message,
    });
    return res.status(500).json({
      error: 'Failed to start Billing Portal',
      detail: err?.raw?.message || err?.message || null
    });
  }
});

/**
 * POST /api/billing/cancel
 * Set cancel at period end + send emails to admin & customer.
 */
router.post('/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });

    const email = row.email;
    const customerId = row.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'No Stripe customer on file' });

    const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
    const sub = subs.data[0];
    if (!sub) return res.status(400).json({ error: 'No active subscription found' });

    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });

    // Send emails (fire-and-forget)
    const endDt = sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toUTCString()
      : 'the end of your current period';

    emailAdmin(
      `❌ Subscription set to cancel — ${email}`,
      `<p>User <strong>${email}</strong> set subscription <code>${sub.id}</code> to cancel at period end.</p>
       <p><strong>Current period ends:</strong> ${endDt}</p>`,
      `User ${email} set subscription ${sub.id} to cancel at period end. Current period ends: ${endDt}`
    ).catch(()=>{});

    emailCustomer(
      email,
      'Your subscription will cancel at period end',
      `<p>Hi,</p>
       <p>Your subscription has been scheduled to cancel at the end of your current billing period (${endDt}).</p>
       <p>If this was a mistake, you can resume anytime from your <a href="${FRONTEND}/account.html">account page</a>.</p>
       <p>— Print Shop Invoice App</p>`
    ).catch(()=>{});

    res.json({ ok: true });
  } catch (err) {
    console.error('billing/cancel error:', err?.message || err);
    res.status(500).json({ error: 'Unable to update subscription' });
  }
});

/**
 * POST /api/billing/resume
 * Clear cancel at period end + send emails to admin & customer.
 */
router.post('/resume', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });

    const email = row.email;
    const customerId = row.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'No Stripe customer on file' });

    // Look up the latest subscription (active or trialing)
    const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
    const sub = subs.data[0];
    if (!sub) return res.status(400).json({ error: 'No active subscription found' });

    if (!sub.cancel_at_period_end) {
      // Nothing to do; tell frontend so it can show a friendly message
      return res.json({ ok: true, alreadyActive: true });
    }

    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });

    // Send emails (fire-and-forget)
    emailAdmin(
      `▶️ Subscription resumed — ${email}`,
      `<p>User <strong>${email}</strong> resumed subscription <code>${sub.id}</code> (cancel_at_period_end cleared).</p>`,
      `User ${email} resumed subscription ${sub.id} (cancel_at_period_end cleared).`
    ).catch(()=>{});

    emailCustomer(
      email,
      'Your subscription has been resumed',
      `<p>Hi,</p>
       <p>Your subscription has been resumed. It will continue to renew unless you cancel.</p>
       <p>You can manage your billing any time from your <a href="${FRONTEND}/account.html">account page</a>.</p>
       <p>— Print Shop Invoice App</p>`
    ).catch(()=>{});

    res.json({ ok: true });
  } catch (err) {
    console.error('billing/resume error:', err?.message || err);
    res.status(500).json({ error: 'Unable to resume subscription' });
  }
});

module.exports = router;
