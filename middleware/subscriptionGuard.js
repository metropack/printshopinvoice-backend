// backend/middleware/subscriptionGuard.js
const pool = require('../db');

module.exports = async function subscriptionGuard(req, res, next) {
  const uid = req.user?.id;

  // Safety: no user → not authenticated
  if (!uid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Emergency bypass for debugging
  if (process.env.BYPASS_SUB_GUARD === '1') {
    console.warn('[sub-guard] BYPASS_SUB_GUARD=1 → allowing request without check');
    return next();
  }

  // Optional: allow local/dev flag (keep if you use it)
  if (process.env.ALLOW_DEV_SUBSCRIPTION === '1' && process.env.NODE_ENV !== 'production') {
    console.warn('[sub-guard] ALLOW_DEV_SUBSCRIPTION=1 in non-prod → allowing request');
    return next();
  }

  console.time(`[sub-guard] uid=${uid}`);
  try {
    // You can change this query to wherever you store status
    // (users, store_info, profiles, etc.)
    const { rows } = await pool.query(
      `SELECT subscription_status
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [uid]
    );

    const status = (rows?.[0]?.subscription_status || '').toLowerCase();

    console.timeEnd(`[sub-guard] uid=${uid}`);
    

    // Consider both active and trialing as allowed
    if (status === 'active' || status === 'trialing') {
      return next();
    }

    // Not paid
    return res.status(402).json({
      error: 'Subscription required',
      details: { user_id: uid, subscription_status: status || 'unknown' },
    });
  } catch (err) {
    console.error('[sub-guard] error:', err);
    // Fail closed, but DO NOT hang
    return res.status(500).json({ error: 'Subscription check failed' });
  }
};
