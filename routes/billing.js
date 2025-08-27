// backend/routes/billing.js
const express = require('express');
const Stripe = require('stripe');
const pool = require('../db');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://mps-site-rouge.vercel.app';

// Start Stripe Customer Portal
router.post('/portal', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT email, stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });

    let { email, stripe_customer_id: customerId } = row;

    // Fallback: look up by email and persist if we never saved it
    if (!customerId) {
      const list = await stripe.customers.list({ email, limit: 1 });
      customerId = list.data[0]?.id;
      if (!customerId) return res.status(400).json({ error: 'No Stripe customer on file' });

      await pool.query(
        'UPDATE users SET stripe_customer_id = $2 WHERE id = $1',
        [req.user.id, customerId]
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_URL}/account.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('billing/portal error:', err?.message || err);
    res.status(500).json({ error: 'Failed to start Billing Portal' });
  }
});

// Cancel at period end
router.post('/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
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
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.id]
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
