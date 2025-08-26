// routes/profile.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

// Ensure these columns exist in "users": name, company, phone, address
// Example migration at bottom.

router.use(authenticate);

// GET /api/profile
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT email, name, company, phone, address, subscription_status,
              stripe_customer_id, stripe_subscription_id
         FROM users
        WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// POST /api/profile
router.post('/', async (req, res) => {
  const { name = '', company = '', phone = '', address = '' } = req.body || {};
  try {
    await pool.query(
      `UPDATE users
          SET name=$1, company=$2, phone=$3, address=$4
        WHERE id=$5`,
      [name, company, phone, address, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

module.exports = router;
