// backend/routes/billing.js
const express = require('express');
const Stripe = require('stripe');
const pool = require('../db');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://mps-site-rouge.vercel.app';

// Create a Customer Portal session
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

    // Fallback: if DB id missing or wrong, look up by email in Stripe TEST/LIVE for this key
    if (!customerId) {
      const list = await stripe.customers.list({ email, limit: 1 });
      customerId = list.data[0]?.id || null;
      if (!customerId) {
        console.error('billing/portal error: No Stripe customer found for email:', email);
        return res.status(400).json({ error: 'No Stripe customer on file' });
      }
      await pool.query(
        'UPDATE users SET stripe_customer_id = $2 WHERE id = $1',
        [req.user.id, customerId]
      );
    }

    // (Optional) sanity check – helpful in logs if the ID is from the wrong account/mode
    try {
      await stripe.customers.retrieve(customerId);
    } catch (e) {
      console.error('billing/portal error: retrieve failed:', e?.message || e);
      // Try email fallback anyway (could be a stale ID)
      const list = await stripe.customers.list({ email, limit: 1 });
      const found = list.data[0]?.id;
      if (!found) {
        return res.status(400).json({ error: 'Stripe customer not found for this account/mode' });
      }
      if (found !== customerId) {
        customerId = found;
        await pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [req.user.id, customerId]);
      }
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_URL}/account.html`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('billing/portal error:', {
      message: err?.message,
      code: err?.code,
      type: err?.type,
      raw: err?.raw?.message,
    });
    return res.status(500).json({ error: 'Failed to start Billing Portal' });
  }
});

// Cancel at period end
router.post('/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.id]
    );
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'No Stripe customer on file' });

    const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
    const sub = subs.data[0];
    if (!sub) return res.status(400).json({ error: 'No active subscription found' });

    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('billing/cancel error:', err?.message || err);
    res.status(500).json({ error: 'Unable to update subscription' });
  }
});

// Resume subscription
router.post('/resume', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.id]
    );
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'No Stripe customer on file' });

    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
    const sub = subs.data[0];
    if (!sub) return res.status(400).json({ error: 'No active subscription found' });

    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    res.json({ ok: true });
  } catch (err) {
    console.error('billing/resume error:', err?.message || err);
    res.status(500).json({ error: 'Unable to resume subscription' });
  }
});

module.exports = router;
