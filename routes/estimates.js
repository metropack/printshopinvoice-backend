// backend/routes/estimates.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

router.use(authenticate);

const clamp = (v, min, max) => Math.min(Math.max(Number(v) || 0, min), max);
const toString = (v) => (v == null ? '' : String(v));
const boolish = (v, def = true) => {
  if (typeof v === 'boolean') return v;
  if (v === 0 || v === '0' || v === 'false' || v === false) return false;
  if (v === 1 || v === '1' || v === 'true' || v === true) return true;
  return def;
};

// Small helper to expose DB error details in dev
function sendDbError(res, err, label) {
  console.error(`❌ ${label}:`, err);
  return res.status(500).json({
    error: 'Internal server error',
    where: label,
    message: err?.message || String(err),
    detail: err?.detail || undefined,
    code: err?.code || undefined,
  });
}

/**
 * GET /api/estimates - Fetch list of estimates (only mine)
 * Returns notes as well (max 150 chars stored).
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
    return sendDbError(res, err, 'Error fetching estimates');
  }
});

/**
 * POST /api/estimates - Create a new estimate (only mine)
 * Supports overrides for built-in items:
 *   variationItems[]: {
 *     variation_id: number (required),
 *     quantity: number,
 *     // optional overrides captured per line:
 *     display_name?: string   (edited description)
 *     unit_price?: number     (edited price for this estimate line)
 *     taxable?: boolean       (override taxable on this line)
 *   }
 * customItems respected as-is.
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

  let cleanNotes = toString(notes).trim();
  if (cleanNotes.length > 150) {
    return res.status(400).json({ error: 'Notes must be 150 characters or fewer.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert header (total 0 for now)
    const { rows: header } = await client.query(
      `INSERT INTO estimates (user_id, customer_id, customer_info, estimate_date, total, notes)
       VALUES ($1, $2, $3, NOW(), 0, $4)
       RETURNING id`,
      [userId, customer_id ?? null, customer_info || {}, cleanNotes]
    );
    const estimateId = header[0].id;

    let taxableSubtotal = 0;
    let nonTaxableSubtotal = 0;

    // --- Built-in items with per-line overrides
    // For each variation line we choose the effective unit price and taxable flag:
    // - If a line override is provided (unit_price/taxable), we use it.
    // - Otherwise we fall back to the canonical product_variations.price and taxable = true.
    for (const raw of variationItems) {
      if (!raw || !raw.variation_id) continue;

      const qty = Number(raw.quantity || 1);

      // Get canonical price as fallback
      const { rows: pvRows } = await client.query(
        `SELECT price, size, accessory, p.name AS product_name
           FROM product_variations pv
           JOIN products p ON p.id = pv.product_id
          WHERE pv.id = $1`,
        [raw.variation_id]
      );
      const canonical = pvRows[0] || { price: 0, product_name: '' };

      const effectiveUnit = Number.isFinite(+raw.unit_price) ? +raw.unit_price : Number(canonical.price || 0);
      const effectiveTaxable = boolish(raw.taxable, true);
      const effectiveName = toString(raw.display_name || raw.product_name || canonical.product_name || '');

      const line = effectiveUnit * qty;
      if (effectiveTaxable) taxableSubtotal += line;
      else nonTaxableSubtotal += line;

      await client.query(
        `INSERT INTO estimate_items
           (estimate_id, product_variation_id, quantity, unit_price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [estimateId, raw.variation_id, qty, effectiveUnit, effectiveTaxable, effectiveName]
      );
    }

    // --- Custom items (respect given values)
    for (const item of customItems) {
      const qty = Number(item.quantity || 1);
      const price = Number(item.price || 0);
      const taxable = boolish(item.taxable, true);
      const line = price * qty;
      if (taxable) taxableSubtotal += line;
      else nonTaxableSubtotal += line;

      await client.query(
        `INSERT INTO custom_estimate_items 
           (estimate_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          estimateId,
          toString(item.product_name),
          toString(item.size),
          price,
          qty,
          toString(item.accessory),
          taxable,
        ]
      );
    }

    // Compute total with user's tax rate
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
    return sendDbError(res, err, 'Error saving estimate');
  } finally {
    client.release();
  }
});

/**
 * PUT /api/estimates/:id - Update an existing estimate in place
 * Replaces children and recomputes totals. Supports the same overrides.
 */
router.put('/:id', async (req, res) => {
  const userId = req.user.id;
  const estimateId = parseInt(req.params.id, 10);
  const { customer_info, variationItems = [], customItems = [], notes } = req.body || {};

  if (!Number.isFinite(estimateId)) {
    return res.status(400).json({ error: 'Invalid estimate id' });
  }

  let cleanNotes = toString(notes).trim();
  if (cleanNotes.length > 150) {
    return res.status(400).json({ error: 'Notes must be 150 characters or fewer.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ownership check
    const { rowCount } = await client.query(
      `SELECT 1 FROM estimates WHERE id = $1 AND user_id = $2`,
      [estimateId, userId]
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update header (bubble to top), include notes
    await client.query(
      `UPDATE estimates
          SET customer_info = $1,
              estimate_date = NOW(),
              notes = $2
        WHERE id = $3 AND user_id = $4`,
      [customer_info || {}, cleanNotes, estimateId, userId]
    );

    // Replace children
    await client.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    await client.query(`DELETE FROM custom_estimate_items WHERE estimate_id = $1`, [estimateId]);

    let taxableSubtotal = 0;
    let nonTaxableSubtotal = 0;

    // Variation items with overrides
    for (const raw of variationItems) {
      if (!raw || !raw.variation_id) continue;

      const qty = Number(raw.quantity || 1);

      const { rows: pvRows } = await client.query(
        `SELECT price, p.name AS product_name
           FROM product_variations pv
           JOIN products p ON p.id = pv.product_id
          WHERE pv.id = $1`,
        [raw.variation_id]
      );
      const canonical = pvRows[0] || { price: 0, product_name: '' };

      const effectiveUnit = Number.isFinite(+raw.unit_price) ? +raw.unit_price : Number(canonical.price || 0);
      const effectiveTaxable = boolish(raw.taxable, true);
      const effectiveName = toString(raw.display_name || raw.product_name || canonical.product_name || '');

      const line = effectiveUnit * qty;
      if (effectiveTaxable) taxableSubtotal += line;
      else nonTaxableSubtotal += line;

      await client.query(
        `INSERT INTO estimate_items
           (estimate_id, product_variation_id, quantity, unit_price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [estimateId, raw.variation_id, qty, effectiveUnit, effectiveTaxable, effectiveName]
      );
    }

    // Custom items
    for (const it of customItems) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.price || 0);
      const taxable = boolish(it.taxable, true);
      const line = price * qty;

      if (taxable) taxableSubtotal += line;
      else nonTaxableSubtotal += line;

      await client.query(
        `INSERT INTO custom_estimate_items
           (estimate_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [estimateId, toString(it.product_name), toString(it.size), price, qty, toString(it.accessory), taxable]
      );
    }

    // Recompute with tax
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
    return sendDbError(res, err, 'Error updating estimate');
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/estimates/:id/notes - Update notes only (max 150 chars)
 */
router.patch('/:id/notes', async (req, res) => {
  const estimateId = req.params.id;
  const userId = req.user.id;

  let cleanNotes = toString(req.body?.notes).trim();
  if (cleanNotes.length > 150) {
    return res.status(400).json({ error: 'Notes must be 150 characters or fewer.' });
  }

  try {
    const check = await pool.query(
      `SELECT 1 FROM estimates WHERE id = $1 AND user_id = $2`,
      [estimateId, userId]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query(
      `UPDATE estimates SET notes = $1 WHERE id = $2 AND user_id = $3`,
      [cleanNotes, estimateId, userId]
    );

    res.json({ message: 'Notes updated' });
  } catch (err) {
    return sendDbError(res, err, 'Error updating estimate notes');
  }
});

/**
 * GET /api/estimates/:id/items - Load estimate items (only mine)
 * Prefer per-line overrides; fall back to canonical values.
 */
router.get('/:id/items', async (req, res) => {
  const estimateId = req.params.id;
  const userId = req.user.id;

  try {
    const check = await pool.query(
      `SELECT 1 FROM estimates WHERE id = $1 AND user_id = $2`,
      [estimateId, userId]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows: variationItems } = await pool.query(
      `SELECT 
         ei.product_variation_id AS variation_id,
         COALESCE(ei.unit_price, pv.price) AS price,
         COALESCE(ei.display_name, p.name) AS product_name,
         COALESCE(ei.taxable, TRUE) AS taxable,
         pv.size,
         pv.accessory,
         ei.quantity
       FROM estimate_items ei
       JOIN product_variations pv ON pv.id = ei.product_variation_id
       JOIN products p ON pv.product_id = p.id
      WHERE ei.estimate_id = $1`,
      [estimateId]
    );

    const { rows: customItems } = await pool.query(
      `SELECT product_name, size, price, quantity, accessory, taxable
         FROM custom_estimate_items
        WHERE estimate_id = $1`,
      [estimateId]
    );

    const combinedItems = [
      ...variationItems.map(v => ({
        type: 'variation',
        product_name: v.product_name,
        size: v.size,
        price: Number(v.price),
        quantity: v.quantity,
        accessory: v.accessory,
        taxable: !!v.taxable,
        variation_id: v.variation_id,
      })),
      ...customItems.map(c => ({
        type: 'custom',
        product_name: c.product_name,
        size: c.size,
        price: Number(c.price),
        quantity: c.quantity,
        accessory: c.accessory,
        taxable: !!c.taxable,
        variation_id: null,
      })),
    ];

    res.json(combinedItems);
  } catch (err) {
    return sendDbError(res, err, 'Failed to load estimate items');
  }
});

/**
 * DELETE /api/estimates/:id - Delete an estimate (only mine)
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

    const { rowCount } = await pool.query(
      `DELETE FROM estimates WHERE id = $1 AND user_id = $2`,
      [estimateId, userId]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'Estimate not found after child deletes' });
    }

    res.json({ message: 'Estimate deleted' });
  } catch (err) {
    return sendDbError(res, err, 'Error deleting estimate');
  }
});

/**
 * GET /api/estimates/search/customers - autocomplete (only mine)
 */
router.get('/search/customers', async (req, res) => {
  const search = req.query.q || '';
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (name, company) * FROM customers
       WHERE user_id = $2
         AND (name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR company ILIKE $1)
       ORDER BY name, company, created_at DESC
       LIMIT 10`,
      [`%${search}%`, userId]
    );
    res.json(result.rows);
  } catch (err) {
    return sendDbError(res, err, 'Error searching customers');
  }
});

/**
 * POST /api/estimates/:id/convert-to-invoice (atomic)
 * Carries per-line overrides (display_name, unit_price, taxable) to invoice_items.
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
  if (discType === 'percent') discVal = clamp(discVal, 0, 100);
  else discVal = clamp(discVal, 0, 1e12);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ownership + header
    const { rows: estRows } = await client.query(
      `SELECT id, customer_info, notes
         FROM estimates
        WHERE id = $1 AND user_id = $2`,
      [estimateId, userId]
    );
    if (!estRows[0]) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Access denied' });
    }
    const carriedNotes = toString(estRows[0].notes || '');
    const invNotes = toString(req.body?.notes ?? carriedNotes).slice(0, 2000);

    // Create invoice
    const { rows: invHdr } = await client.query(
      `INSERT INTO invoices (user_id, customer_info, invoice_date, total,
                             discount_type, discount_value, notes)
       SELECT $1, customer_info, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'), 0,
              $2, $3, $4
         FROM estimates
        WHERE id = $5 AND user_id = $1
       RETURNING id`,
      [userId, discType, discVal, invNotes, estimateId]
    );
    const invoiceId = invHdr[0].id;

    // Built-in lines with overrides → invoice_items
    let total = 0;
    let taxableSubtotal = 0;

    const { rows: varLines } = await client.query(
      `SELECT 
         ei.product_variation_id AS variation_id,
         COALESCE(ei.unit_price, pv.price) AS price,
         COALESCE(ei.display_name, p.name) AS product_name,
         COALESCE(ei.taxable, TRUE) AS taxable,
         ei.quantity
       FROM estimate_items ei
       JOIN product_variations pv ON pv.id = ei.product_variation_id
       JOIN products p ON p.id = pv.product_id
      WHERE ei.estimate_id = $1`,
      [estimateId]
    );

    for (const line of varLines) {
      const qty = Number(line.quantity || 1);
      const price = Number(line.price || 0);
      const amt = price * qty;
      total += amt;
      if (line.taxable) taxableSubtotal += amt;

      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, product_variation_id, quantity, price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invoiceId, line.variation_id, qty, price, !!line.taxable, toString(line.product_name)]
      );
    }

    // Custom lines → custom_invoice_items (as-is)
    const { rows: customLines } = await client.query(
      `SELECT product_name, size, price, quantity, accessory,
              (CASE WHEN taxable IN (TRUE, 'true', 1) THEN TRUE ELSE FALSE END) AS taxable
         FROM custom_estimate_items
        WHERE estimate_id = $1`,
      [estimateId]
    );

    for (const it of customLines) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.price || 0);
      const amt = price * qty;
      total += amt;
      if (it.taxable) taxableSubtotal += amt;

      await client.query(
        `INSERT INTO custom_invoice_items
           (invoice_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invoiceId, toString(it.product_name), toString(it.size), price, qty, toString(it.accessory), !!it.taxable]
      );
    }

    // Compute final invoice total with discount
    const { rows: rateRows } = await client.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);

    const nonTaxableSubtotal = total - taxableSubtotal;
    let finalTotal;

    if (discType === 'amount') {
      const baseGrand = taxableSubtotal * (1 + taxRate) + nonTaxableSubtotal;
      const maxDisc = clamp(discVal, 0, baseGrand);
      finalTotal = Math.max(0, baseGrand - maxDisc);
    } else {
      const pct = clamp(discVal, 0, 100) / 100;
      const taxableAfter = taxableSubtotal * (1 - pct);
      const nonTaxAfter  = nonTaxableSubtotal * (1 - pct);
      const taxAfter     = taxableAfter * taxRate;
      finalTotal = taxableAfter + nonTaxAfter + taxAfter;
    }

    await client.query(
      `UPDATE invoices
          SET total = $1
        WHERE id = $2 AND user_id = $3`,
      [finalTotal, invoiceId, userId]
    );

    // Clean up estimate
    await client.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    await client.query(`DELETE FROM custom_estimate_items WHERE estimate_id = $1`, [estimateId]);
    await client.query(`DELETE FROM estimates WHERE id = $1 AND user_id = $2`, [estimateId, userId]);

    await client.query('COMMIT');
    res.status(201).json({ message: 'Converted to invoice', invoiceId });
  } catch (err) {
    await client.query('ROLLBACK');
    return sendDbError(res, err, 'convert-to-invoice failed');
  } finally {
    client.release();
  }
});

module.exports = router;
