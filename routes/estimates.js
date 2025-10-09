const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

router.use(authenticate);

const clamp = (v, min, max) => Math.min(Math.max(Number(v) || 0, min), max);
const toString = (v) => (v == null ? '' : String(v));

// Small helper so we can safely read bools sent as strings
const toBool = (v, def = true) => {
  if (typeof v === 'boolean') return v;
  if (v == null) return def;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return !['false', '0', 'no', 'off'].includes(v.toLowerCase());
  return def;
};

/**
 * GET /api/estimates - Fetch list of estimates (current user only)
 * Returns notes too.
 */
router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT 
         e.id,
         e.customer_info,
         e.estimate_date,
         ROUND(e.total, 2) AS total,
         e.notes
       FROM estimates e
       WHERE e.user_id = $1
       ORDER BY e.estimate_date DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching estimates:', err);
    res.status(500).json({ error: 'Failed to load estimates' });
  }
});

/**
 * POST /api/estimates - Create a new estimate (current user)
 * - Built-in items are stored line-by-line in estimate_items (NO DEDUP).
 * - Allows per-line overrides: unit_price, taxable, display_name.
 * - Custom items go to custom_estimate_items with their own taxable flag.
 * - Total uses store tax_rate (default 0.06).
 * - Notes capped at 150 chars.
 */
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const {
    customer_id,
    customer_info,
    variationItems = [],
    customItems = [],
    notes,
  } = req.body || {};

  const cleanNotes = toString(notes).trim();
  if (cleanNotes.length > 150) {
    return res.status(400).json({ error: 'Notes must be 150 characters or fewer.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Header
    const { rows: estRows } = await client.query(
      `INSERT INTO estimates (user_id, customer_id, customer_info, estimate_date, total, notes)
       VALUES ($1, $2, $3, NOW(), 0, $4)
       RETURNING id`,
      [userId, customer_id ?? null, customer_info || {}, cleanNotes]
    );
    const estimateId = estRows[0].id;

    let taxableSubtotal = 0;
    let nonTaxableSubtotal = 0;

    // Built-in items: one row per selection (even if same variation appears multiple times)
    for (const it of (Array.isArray(variationItems) ? variationItems : [])) {
      const variationId = Number(it.variation_id ?? it.variationId);
      if (!Number.isFinite(variationId)) continue;

      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);

      // Allow overriding the built-in price/desc/taxable at the line level
      const overridePrice = it.unit_price != null ? Number(it.unit_price) : Number(it.price);
      const useOverridePrice = Number.isFinite(overridePrice);
      const displayName = toString(it.display_name || it.product_name || '').trim() || null;
      const taxable = toBool(it.taxable, true);

      // If no unit price override was given, pull current PV price
      let lineUnitPrice = useOverridePrice ? overridePrice : null;
      if (lineUnitPrice == null) {
        const { rows: priceRows } = await client.query(
          `SELECT price FROM product_variations WHERE id = $1`,
          [variationId]
        );
        lineUnitPrice = Number(priceRows[0]?.price || 0);
      }

      const lineTotal = lineUnitPrice * qty;
      if (taxable) taxableSubtotal += lineTotal;
      else nonTaxableSubtotal += lineTotal;

      await client.query(
        `INSERT INTO estimate_items
           (estimate_id, product_variation_id, quantity, unit_price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [estimateId, variationId, qty, lineUnitPrice, taxable, displayName]
      );
    }

    // Custom items
    for (const it of (Array.isArray(customItems) ? customItems : [])) {
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const price = Number(it.price) || 0;
      const taxable = toBool(it.taxable, true);

      if (taxable) taxableSubtotal += price * qty;
      else nonTaxableSubtotal += price * qty;

      await client.query(
        `INSERT INTO custom_estimate_items
           (estimate_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          estimateId,
          toString(it.product_name || it.productName),
          toString(it.size),
          price,
          qty,
          toString(it.accessory),
          taxable,
        ]
      );
    }

    // Tax rate
    const { rows: rateRows } = await client.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);
    const finalTotal = taxableSubtotal * (1 + taxRate) + nonTaxableSubtotal;

    await client.query(
      `UPDATE estimates SET total = $1 WHERE id = $2 AND user_id = $3`,
      [finalTotal, estimateId, userId]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Estimate saved', estimateId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error saving estimate:', err);
    res.status(500).json({ error: 'Failed to save estimate' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/estimates/:id - Replace items in place (keeps duplicates)
 */
router.put('/:id', async (req, res) => {
  const userId = req.user.id;
  const estimateId = parseInt(req.params.id, 10);
  const { customer_info, variationItems = [], customItems = [], notes } = req.body || {};

  if (!Number.isFinite(estimateId)) {
    return res.status(400).json({ error: 'Invalid estimate id' });
  }

  const cleanNotes = toString(notes).trim();
  if (cleanNotes.length > 150) {
    return res.status(400).json({ error: 'Notes must be 150 characters or fewer.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ownership
    const { rowCount } = await client.query(
      `SELECT 1 FROM estimates WHERE id = $1 AND user_id = $2`,
      [estimateId, userId]
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Access denied' });
    }

    await client.query(
      `UPDATE estimates
          SET customer_info = $1,
              estimate_date = NOW(),
              notes = $2
        WHERE id = $3 AND user_id = $4`,
      [customer_info || {}, cleanNotes, estimateId, userId]
    );

    await client.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    await client.query(`DELETE FROM custom_estimate_items WHERE estimate_id = $1`, [estimateId]);

    let taxableSubtotal = 0;
    let nonTaxableSubtotal = 0;

    // Re-insert all built-ins (line-by-line, no dedup)
    for (const it of (Array.isArray(variationItems) ? variationItems : [])) {
      const variationId = Number(it.variation_id ?? it.variationId);
      if (!Number.isFinite(variationId)) continue;

      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const overridePrice = it.unit_price != null ? Number(it.unit_price) : Number(it.price);
      const useOverridePrice = Number.isFinite(overridePrice);
      const displayName = toString(it.display_name || it.product_name || '').trim() || null;
      const taxable = toBool(it.taxable, true);

      let lineUnitPrice = useOverridePrice ? overridePrice : null;
      if (lineUnitPrice == null) {
        const { rows: priceRows } = await client.query(
          `SELECT price FROM product_variations WHERE id = $1`,
          [variationId]
        );
        lineUnitPrice = Number(priceRows[0]?.price || 0);
      }

      const lineTotal = lineUnitPrice * qty;
      if (taxable) taxableSubtotal += lineTotal;
      else nonTaxableSubtotal += lineTotal;

      await client.query(
        `INSERT INTO estimate_items
           (estimate_id, product_variation_id, quantity, unit_price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [estimateId, variationId, qty, lineUnitPrice, taxable, displayName]
      );
    }

    for (const it of (Array.isArray(customItems) ? customItems : [])) {
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const price = Number(it.price) || 0;
      const taxable = toBool(it.taxable, true);

      if (taxable) taxableSubtotal += price * qty;
      else nonTaxableSubtotal += price * qty;

      await client.query(
        `INSERT INTO custom_estimate_items
           (estimate_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          estimateId,
          toString(it.product_name || it.productName),
          toString(it.size),
          price,
          qty,
          toString(it.accessory),
          taxable,
        ]
      );
    }

    const { rows: rateRows } = await client.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);
    const finalTotal = taxableSubtotal * (1 + taxRate) + nonTaxableSubtotal;

    await client.query(
      `UPDATE estimates SET total = $1 WHERE id = $2 AND user_id = $3`,
      [finalTotal, estimateId, userId]
    );

    await client.query('COMMIT');
    res.json({ message: 'Estimate updated', estimateId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error updating estimate:', err);
    res.status(500).json({ error: 'Failed to update estimate' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/estimates/:id/items - Load estimate items (NO DEDUP, includes line_id)
 */
// GET /api/estimates/:id/items
router.get('/:id/items', async (req, res) => {
  const estimateId = req.params.id;
  const userId = req.user.id;

  try {
    // Ownership
    const own = await pool.query(
      `SELECT 1 FROM estimates WHERE id=$1 AND user_id=$2`,
      [estimateId, userId]
    );
    if (own.rowCount === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Built-in (variation) lines with overrides
    const { rows: variationItems } = await pool.query(
      `
      SELECT
        ei.product_variation_id        AS variation_id,
        pv.size,
        COALESCE(ei.unit_price, pv.price)::numeric(12,2) AS price,
        ei.quantity,
        COALESCE(ei.taxable, TRUE)     AS taxable,
        pv.accessory,
        COALESCE(ei.display_name, p.name) AS product_name
      FROM estimate_items ei
      JOIN product_variations pv ON pv.id = ei.product_variation_id
      JOIN products p           ON p.id  = pv.product_id
      WHERE ei.estimate_id = $1
      ORDER BY ei.id ASC
      `,
      [estimateId]
    );

    // Custom lines unchanged
    const { rows: customItems } = await pool.query(
      `
      SELECT
        product_name,
        size,
        price::numeric(12,2)  AS price,
        quantity,
        accessory,
        (CASE WHEN taxable IN (TRUE, 'true', 1) THEN TRUE ELSE FALSE END) AS taxable
      FROM custom_estimate_items
      WHERE estimate_id = $1
      ORDER BY id ASC
      `,
      [estimateId]
    );

    const items = [
      ...variationItems.map(v => ({
        type: 'variation',
        variation_id: v.variation_id,
        product_name: v.product_name,
        size: v.size,
        price: Number(v.price),
        quantity: v.quantity,
        accessory: v.accessory,
        taxable: !!v.taxable,
      })),
      ...customItems.map(c => ({
        type: 'custom',
        variation_id: null,
        product_name: c.product_name,
        size: c.size,
        price: Number(c.price),
        quantity: c.quantity,
        accessory: c.accessory,
        taxable: !!c.taxable,
      })),
    ];

    res.json(items);
  } catch (err) {
    console.error('❌ Estimates items GET failed:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      where: err.where,
      stack: err.stack,
    });
    res.status(500).json({ error: 'Failed to load estimate items' });
  }
});


/**
 * DELETE /api/estimates/:id
 */
router.delete('/:id', async (req, res) => {
  const estimateId = req.params.id;
  const userId = req.user.id;

  if (!/^\d+$/.test(String(estimateId))) {
    return res.status(400).json({ error: 'Invalid estimate id' });
  }

  try {
    const check = await pool.query(
      `SELECT 1 FROM estimates WHERE id = $1 AND user_id = $2`,
      [estimateId, userId]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    await pool.query(`DELETE FROM custom_estimate_items WHERE estimate_id = $1`, [estimateId]);
    await pool.query(`DELETE FROM estimates WHERE id = $1 AND user_id = $2`, [estimateId, userId]);

    res.json({ message: 'Estimate deleted' });
  } catch (err) {
    console.error('❌ Error deleting estimate:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/estimates/:id/convert-to-invoice
 * (keeps duplicates 1:1)
 */
router.post('/:id/convert-to-invoice', async (req, res) => {
  const estimateId = req.params.id;
  const userId = req.user.id;

  if (!/^\d+$/.test(String(estimateId))) {
    return res.status(400).json({ error: 'Invalid estimate id' });
  }

  const rawType = String(req.body?.discount_type || '').toLowerCase();
  const discType = rawType === 'percent' ? 'percent' : 'amount';
  let discVal = Number(req.body?.discount_value || 0);
  discVal = discType === 'percent' ? clamp(discVal, 0, 100) : clamp(discVal, 0, 1e12);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: estHdr } = await client.query(
      `SELECT id, customer_info, notes
         FROM estimates
        WHERE id = $1 AND user_id = $2`,
      [estimateId, userId]
    );
    if (!estHdr[0]) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Access denied' });
    }

    const carriedNotes = toString(estHdr[0].notes || '');
    const invNotes = toString(req.body?.notes ?? carriedNotes).slice(0, 2000);

    const { rows: invRows } = await client.query(
      `INSERT INTO invoices (user_id, customer_info, invoice_date, total, discount_type, discount_value, notes)
       VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'), 0, $3, $4, $5)
       RETURNING id`,
      [userId, estHdr[0].customer_info || {}, discType, discVal, invNotes]
    );
    const invoiceId = invRows[0].id;

    // Load estimate items (with overrides) and copy 1:1
    const { rows: varItems } = await client.query(
      `SELECT 
         ei.product_variation_id AS variation_id,
         ei.quantity,
         COALESCE(ei.unit_price, pv.price) AS unit_price,
         COALESCE(ei.taxable, TRUE) AS taxable,
         COALESCE(ei.display_name, p.name) AS display_name
       FROM estimate_items ei
       JOIN product_variations pv ON pv.id = ei.product_variation_id
       JOIN products p ON p.id = pv.product_id
       WHERE ei.estimate_id = $1
       ORDER BY ei.id ASC`,
      [estimateId]
    );

    const { rows: custItems } = await client.query(
      `SELECT product_name, size, price, quantity, accessory,
              (CASE WHEN taxable IN (TRUE, 'true', 1) THEN TRUE ELSE FALSE END) AS taxable
         FROM custom_estimate_items
        WHERE estimate_id = $1
        ORDER BY id ASC`,
      [estimateId]
    );

    let taxableSubtotal = 0;
    let nonTaxableSubtotal = 0;

    for (const it of varItems) {
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const price = Number(it.unit_price) || 0;
      const line = price * qty;

      if (it.taxable) taxableSubtotal += line;
      else nonTaxableSubtotal += line;

      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, product_variation_id, quantity, price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invoiceId, it.variation_id, qty, price, it.taxable, it.display_name]
      );
    }

    for (const it of custItems) {
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const price = Number(it.price) || 0;
      const line = price * qty;

      if (it.taxable) taxableSubtotal += line;
      else nonTaxableSubtotal += line;

      await client.query(
        `INSERT INTO custom_invoice_items
           (invoice_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invoiceId, it.product_name, it.size, price, qty, it.accessory, it.taxable]
      );
    }

    const { rows: rateRows } = await client.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);

    let finalTotal;
    if (discType === 'amount') {
      finalTotal = taxableSubtotal * (1 + taxRate) + nonTaxableSubtotal - clamp(discVal, 0, 1e12);
      finalTotal = Math.max(0, finalTotal);
    } else {
      const pct = clamp(discVal, 0, 100) / 100;
      const taxableAfter = taxableSubtotal * (1 - pct);
      const nonTaxAfter = nonTaxableSubtotal * (1 - pct);
      const taxAfter = taxableAfter * taxRate;
      finalTotal = taxableAfter + nonTaxAfter + taxAfter;
    }

    await client.query(`UPDATE invoices SET total = $1 WHERE id = $2 AND user_id = $3`, [
      finalTotal,
      invoiceId,
      userId,
    ]);

    // Clean up estimate
    await client.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    await client.query(`DELETE FROM custom_estimate_items WHERE estimate_id = $1`, [estimateId]);
    await client.query(`DELETE FROM estimates WHERE id = $1 AND user_id = $2`, [estimateId, userId]);

    await client.query('COMMIT');
    res.status(201).json({ message: 'Converted to invoice', invoiceId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ convert-to-invoice failed:', err);
    res.status(500).json({ error: 'Failed to convert estimate to invoice' });
  } finally {
    client.release();
  }
});

module.exports = router;
