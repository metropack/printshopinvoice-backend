// backend/routes/diag.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// No auth; purely for temporary diagnostics.
// Remove once we're done.

router.get('/health', (_req, res) => {
  res.json({ ok: true, t: Date.now() });
});

// Times the PRODUCTS query used by your /api/products route, but LIMITed
router.get('/products-ping', async (_req, res) => {
  try {
    console.time('diag-products');
    // Very light query – adjust to match your real /api/products core
    const { rows } = await pool.query(`
      SELECT p.id as product_id, p.name, pv.id as variation_id, pv.size, pv.price
      FROM products p
      LEFT JOIN product_variations pv ON pv.product_id = p.id
      ORDER BY p.id
      LIMIT 50
    `);
    console.timeEnd('diag-products');
    res.json({ ok: true, sample: rows.length });
  } catch (e) {
    console.error('diag products error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Times a minimal INVOICES query for the current user (requires Authorization)
router.get('/invoices-ping', async (req, res) => {
  try {
    // Accept a userId in header only for diag
    const userId = Number(req.headers['x-user-id'] || 0);
    if (!userId) return res.status(400).json({ ok: false, error: 'x-user-id required' });

    console.time('diag-invoices');
    const r = await pool.query(
      `SELECT id, invoice_date, total
         FROM invoices
        WHERE user_id = $1
        ORDER BY invoice_date DESC
        LIMIT 5`,
      [userId]
    );
    console.timeEnd('diag-invoices');
    res.json({ ok: true, sample: r.rowCount });
  } catch (e) {
    console.error('diag invoices error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
