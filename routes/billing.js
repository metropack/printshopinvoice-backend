// routes/billing.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

router.use(authenticate);

// Return subscription status + period end + cancel flag
router.get('/status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT subscription_status, stripe_customer_id, stripe_subscription_id
         FROM users WHERE id=$1`,
      [req.user.id]
    );
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });

    const resp = {
      subscription_status: u.subscription_status || 'inactive',
      cancel_at_period_end: false,
      current_period_end: null
    };

    if (u.stripe_subscription_id) {
      const sub = await stripe.subscriptions.retrieve(u.stripe_subscription_id);
      resp.cancel_at_period_end = sub.cancel_at_period_end;
      resp.current_period_end = sub.current_period_end;
    }
    res.json(resp);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load billing status' });
  }
});

// Stripe Customer Portal
router.post('/portal', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT email, stripe_customer_id FROM users WHERE id=$1`,
      [req.user.id]
    );
    const u = rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });

    let customerId = u.stripe_customer_id;
    if (!customerId) {
      // create a customer if we don't have one yet
      const c = await stripe.customers.create({ email: u.email });
      customerId = c.id;
      await pool.query(
        `UPDATE users SET stripe_customer_id=$1 WHERE id=$2`,
        [customerId, req.user.id]
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_URL}/account.html`
    });
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: 'Failed to start Billing Portal' });
  }
});

// Cancel at next period end
router.post('/cancel', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT stripe_subscription_id FROM users WHERE id=$1`,
      [req.user.id]
    );
    const subId = rows[0]?.stripe_subscription_id;
    if (!subId) return res.status(400).json({ error: 'No active subscription' });

    await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to cancel at period end' });
  }
});

// Resume (unset cancel_at_period_end)
router.post('/resume', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT stripe_subscription_id FROM users WHERE id=$1`,
      [req.user.id]
    );
    const subId = rows[0]?.stripe_subscription_id;
    if (!subId) return res.status(400).json({ error: 'No subscription' });

    await stripe.subscriptions.update(subId, { cancel_at_period_end: false });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to resume subscription' });
  }
});

module.exports = router;
