// backend/routes/stripeWebhook.js
const express = require('express');
const Stripe = require('stripe');
const pool = require('../db');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// ❗ Use raw body ONLY on this route (do not apply express.json() here)
const rawBody = express.raw({ type: 'application/json' });

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
       * Fires after a successful Checkout. We:
       * - set subscription_status = 'active'
       * - store stripe_customer_id (cus_...)
       * - store stripe_subscription_id (sub_...)
       *
       * We try (in order): userId (client_reference_id/metadata), customerId, email.
       */
      case 'checkout.session.completed': {
        const s = event.data.object;

        const userIdRaw =
          s.client_reference_id || (s.metadata && s.metadata.userId);
        const userId =
          userIdRaw && /^\d+$/.test(String(userIdRaw)) ? Number(userIdRaw) : null;

        const customerId = s.customer || null;        // cus_...
        const subscriptionId = s.subscription || null; // sub_...
        const email =
          s.customer_details?.email || s.customer_email || null;

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
        }
        break;
      }

      /**
       * Keep DB in sync when the subscription changes (past_due, canceled, etc).
       * We collapse to two app states: active / inactive.
       */
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const subscriptionId = sub.id;
        const status = sub.status; // active | trialing | past_due | canceled | unpaid | incomplete...

        const newStatus =
          status === 'active' || status === 'trialing' ? 'active' : 'inactive';

        await pool.query(
          `UPDATE users
              SET subscription_status    = $2,
                  stripe_subscription_id = $3
            WHERE stripe_customer_id = $1`,
          [customerId, newStatus, subscriptionId]
        );
        break;
      }

      /**
       * Subscription ended → mark inactive and clear subscription id.
       */
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const subscriptionId = sub.id;

        await pool.query(
          `UPDATE users
              SET subscription_status = 'inactive',
                  stripe_subscription_id = NULL
            WHERE stripe_customer_id = $1
               OR stripe_subscription_id = $2`,
          [customerId, subscriptionId]
        );
        break;
      }

      /**
       * Optional: mark inactive on failed payment, active on success.
       * (These are conservative; your app logic might not need them.)
       */
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const customerId = inv.customer;
        await pool.query(
          `UPDATE users SET subscription_status='inactive'
            WHERE stripe_customer_id=$1`,
          [customerId]
        );
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
        break;
      }

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
