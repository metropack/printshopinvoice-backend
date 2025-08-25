// blocks any request unless the user's subscription is active
const ALLOW_DEV_SUBSCRIPTION = process.env.ALLOW_DEV_SUBSCRIPTION === '1';
module.exports = async function subscriptionGuard(req, res, next) {
  if (ALLOW_DEV_SUBSCRIPTION) return next();

const pool = require('../db');

module.exports = async function subscriptionGuard(req, res, next) {
  try {
    // `authenticate` must set req.user.id from the JWT
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthenticated' });

    const { rows } = await pool.query(
      'SELECT subscription_status FROM users WHERE id = $1',
      [req.user.id]
    );

    const status = rows[0]?.subscription_status || 'inactive';

    // allow active (and optionally trialing)
    if (status === 'active' /* || status === 'trialing' */) return next();

    return res.status(402).json({ error: 'Subscription inactive' }); // 402 Payment Required
  } catch (e) {
    console.error('subscriptionGuard error:', e);
    return res.status(500).json({ error: 'Subscription check failed' });
  }
};
};