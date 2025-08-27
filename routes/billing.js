const express = require('express');
const Stripe = require('stripe');
const pool = require('../db');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://mps-site-rouge.vercel.app';

/**
 * GET /api/billing/status
 * Return subscription status + key dates for the logged-in user.
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
 * Create a Stripe Customer Portal session.
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
    // send the detail back so the UI can show it
    return res.status(500).json({
      error: 'Failed to start Billing Portal',
      detail: err?.raw?.message || err?.message || null
    });
  }
});

/**
 * POST /api/billing/cancel
 * Set cancel at period end.
 */
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

/**
 * POST /api/billing/resume
 * Clear cancel at period end.
 */
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
