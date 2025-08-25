const express = require('express');
const Stripe = require('stripe');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const pool = require('../db'); // ← shared pool


// ✅ raw body middleware
const expressRaw = express.raw({ type: 'application/json' });

router.post('/stripe-webhook', expressRaw, (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Handle event type
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_email;

    pool.query(
      `UPDATE users SET subscription_status = 'active' WHERE email = $1`,
      [customerEmail]
    ).catch(err => {});
  }

  res.json({ received: true });
});

module.exports = router;