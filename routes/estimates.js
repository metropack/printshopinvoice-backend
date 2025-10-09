// backend/routes/estimates.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

router.use(authenticate);

// ----------------- helpers -----------------
const clamp = (v, min, max) => Math.min(Math.max(Number(v) || 0, min), max);
const toString = (v) => (v == null ? '' : String(v));

function sendDbError(res, err, label) {
  console.error(`❌ ${label}:`, err && err.stack ? err.stack : err);
  return res.status(500).json({
    error: 'Internal server error',
    where: label,
    message: err?.message || String(err),
    detail: err?.detail || undefined,
    code: err?.code || undefined,
    stack: err?.stack || undefined, // TEMP: keep while debugging
  });
}

// TEMP: verify remote schema has the new columns
router.get('/__diag/schema', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'estimate_items'
      ORDER BY column_name
    `);
    res.json({ table: 'estimate_items', columns: rows.map(r => r.column_name) });
  } catch (err) {
    return sendDbError(res, err, 'Schema check failed');
  }
});

/**
 * GET /api/estimates - list my estimates
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
 * POST /api/estimates - create
 * Supports built-in line overrides:
 *  - variationItems[*]: { variation_id, quantity, price?, taxable?, product_name? }
 *    (price -> unit_price override; product_name -> display_name)
 *  - customItems unchanged
 */
router.post('/', async (req, res) => {
  console.log('📥 /api/estimates body:', JSON.stringify(req.body));
  const userId = req.user.id;
  const { customer_id, customer_info, variationItems = [], customItems = [], notes } = req.body || {};

  let cleanNotes = toString(notes).trim();
  if (cleanNotes.length > 150) {
    return res.status(400).json({ error: 'Notes must be 150 characters or fewer.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // header
    const { rows: hdr } = await client.query(
      `INSERT INTO estimates (user_id, customer_id, customer_info, estimate_date, total, notes)
       VALUES ($1, $2, $3, NOW(), 0, $4)
       RETURNING id`,
      [userId, customer_id ?? null, customer_info || {}, cleanNotes]
    );
    const estimateId = hdr[0].id;

    let totalTaxable = 0;
    let totalNonTaxable = 0;

    // --- built-in items with per-line overrides ---
    for (const raw of variationItems) {
      const variationId = Number(raw.variation_id);
      const qty = Math.max(1, Number(raw.quantity || 1));

      // fetch catalog price as fallback
      const { rows: pvRows } = await client.query(
        `SELECT pv.price, pv.size, pv.accessory, p.name AS product_name
           FROM product_variations pv
           JOIN products p ON p.id = pv.product_id
          WHERE pv.id = $1`,
        [variationId]
      );
      const pv = pvRows[0] || {};
      const catalogPrice = Number(pv.price || 0);

      const unitPrice = Number(
        raw.unit_price ?? raw.price ?? catalogPrice
      );
      const taxable = raw.taxable !== undefined ? !!raw.taxable : true;
      const displayName = toString(raw.display_name ?? raw.product_name ?? pv.product_name);

      // compute totals using overrides
      const line = unitPrice * qty;
      if (taxable) totalTaxable += line;
      else totalNonTaxable += line;

      // persist with overrides
      await client.query(
        `INSERT INTO estimate_items
           (estimate_id, product_variation_id, quantity, unit_price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [estimateId, variationId, qty, unitPrice, taxable, displayName || null]
      );
    }

    // --- custom items (unchanged) ---
    for (const raw of customItems) {
      const qty = Math.max(1, Number(raw.quantity || 1));
      const price = Number(raw.price || 0);
      const taxable = raw.taxable === true || raw.taxable === 'true' || raw.taxable === 1;
      const line = price * qty;
      if (taxable) totalTaxable += line;
      else totalNonTaxable += line;

      await client.query(
        `INSERT INTO custom_estimate_items 
           (estimate_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          estimateId,
          toString(raw.product_name),
          toString(raw.size),
          price,
          qty,
          toString(raw.accessory),
          taxable
        ]
      );
    }

    // tax rate
    const { rows: rateRows } = await client.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);
    const finalTotal = totalTaxable * (1 + taxRate) + totalNonTaxable;

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
 * PUT /api/estimates/:id - update (replace items)
 * Same override semantics as POST.
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

    // ownership
    const { rowCount } = await client.query(
      `SELECT 1 FROM estimates WHERE id = $1 AND user_id = $2`,
      [estimateId, userId]
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Access denied' });
    }

    // header
    await client.query(
      `UPDATE estimates
         SET customer_info = $1,
             estimate_date = NOW(),
             notes = $2
       WHERE id = $3 AND user_id = $4`,
      [customer_info || {}, cleanNotes, estimateId, userId]
    );

    // replace children
    await client.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [estimateId]);
    await client.query(`DELETE FROM custom_estimate_items WHERE estimate_id = $1`, [estimateId]);

    let totalTaxable = 0;
    let totalNonTaxable = 0;

    for (const raw of variationItems) {
      const variationId = Number(raw.variation_id);
      const qty = Math.max(1, Number(raw.quantity || 1));

      const { rows: pvRows } = await client.query(
        `SELECT pv.price, p.name AS product_name
           FROM product_variations pv
           JOIN products p ON p.id = pv.product_id
          WHERE pv.id = $1`,
        [variationId]
      );
      const pv = pvRows[0] || {};
      const catalogPrice = Number(pv.price || 0);

      const unitPrice = Number(raw.unit_price ?? raw.price ?? catalogPrice);
      const taxable = raw.taxable !== undefined ? !!raw.taxable : true;
      const displayName = toString(raw.display_name ?? raw.product_name ?? pv.product_name);

      const line = unitPrice * qty;
      if (taxable) totalTaxable += line;
      else totalNonTaxable += line;

      await client.query(
        `INSERT INTO estimate_items
           (estimate_id, product_variation_id, quantity, unit_price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [estimateId, variationId, qty, unitPrice, taxable, displayName || null]
      );
    }

    for (const it of customItems) {
      const qty = Math.max(1, Number(it.quantity || 1));
      const price = Number(it.price || 0);
      const taxable = it.taxable === true || it.taxable === 'true' || it.taxable === 1;

      const line = price * qty;
      if (taxable) totalTaxable += line;
      else totalNonTaxable += line;

      await client.query(
        `INSERT INTO custom_estimate_items
           (estimate_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [estimateId, toString(it.product_name), toString(it.size), price, qty, toString(it.accessory), taxable]
      );
    }

    const { rows: rateRows } = await client.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);
    const finalTotal = totalTaxable * (1 + taxRate) + totalNonTaxable;

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
 * PATCH /api/estimates/:id/notes
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
    if (check.rowCount === 0) return res.status(403).json({ error: 'Access denied' });

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
 * GET /api/estimates/:id/items - load with overrides
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
         pv.id as variation_id,
         pv.size,
         pv.accessory,
         COALESCE(ei.unit_price, pv.price) AS price,
         COALESCE(ei.display_name, p.name) AS product_name,
         COALESCE(ei.taxable, TRUE) AS taxable,
         ei.quantity
       FROM estimate_items ei
       JOIN product_variations pv ON ei.product_variation_id = pv.id
       JOIN products p ON pv.product_id = p.id
       WHERE ei.estimate_id = $1
       ORDER BY ei.id ASC`,
      [estimateId]
    );

    const { rows: customItems } = await pool.query(
      `SELECT product_name, size, price, quantity, accessory, taxable
         FROM custom_estimate_items
        WHERE estimate_id = $1
        ORDER BY id ASC`,
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
        variation_id: v.variation_id
      })),
      ...customItems.map(c => ({
        type: 'custom',
        product_name: c.product_name,
        size: c.size,
        price: Number(c.price),
        quantity: c.quantity,
        accessory: c.accessory,
        taxable: (c.taxable === true || c.taxable === 'true' || c.taxable === 1),
        variation_id: null
      }))
    ];

    res.json(combinedItems);
  } catch (err) {
    return sendDbError(res, err, 'Failed to load estimate items');
  }
});

/**
 * POST /api/estimates/:id/convert-to-invoice
 * Carries display_name → invoice_items.display_name
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
    const customer_info = estRows[0].customer_info || {};
    const carriedNotes = toString(estRows[0].notes || '');
    const invNotes = toString(req.body?.notes ?? carriedNotes).slice(0, 2000);

    const { rows: variationItems } = await client.query(
      `SELECT 
         ei.product_variation_id AS variation_id,
         ei.quantity,
         COALESCE(ei.unit_price, pv.price) AS price,
         COALESCE(ei.display_name, p.name) AS display_name,
         COALESCE(ei.taxable, TRUE) AS taxable
       FROM estimate_items ei
       JOIN product_variations pv ON pv.id = ei.product_variation_id
       JOIN products p ON p.id = pv.product_id
      WHERE ei.estimate_id = $1
      ORDER BY ei.id ASC`,
      [estimateId]
    );

    const { rows: customItems } = await client.query(
      `SELECT product_name, size, price, quantity, accessory,
              (CASE WHEN taxable IN (TRUE, 'true', 1) THEN TRUE ELSE FALSE END) AS taxable
         FROM custom_estimate_items
        WHERE estimate_id = $1
        ORDER BY id ASC`,
      [estimateId]
    );

    const { rows: invHdr } = await client.query(
      `INSERT INTO invoices (user_id, customer_info, invoice_date, total,
                             discount_type, discount_value, notes)
       VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'), 0,
               $3, $4, $5)
       RETURNING id`,
      [userId, customer_info, discType, discVal, invNotes]
    );
    const invoiceId = invHdr[0].id;

    let total = 0;
    let taxableTotal = 0;

    for (const it of variationItems) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.price || 0);
      const line = price * qty;
      total += line;
      if (it.taxable) taxableTotal += line;

      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, product_variation_id, quantity, price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invoiceId, it.variation_id, qty, price, !!it.taxable, toString(it.display_name) || null]
      );
    }

    for (const it of customItems) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.price || 0);
      const line = price * qty;
      total += line;
      if (it.taxable) taxableTotal += line;

      await client.query(
        `INSERT INTO custom_invoice_items
           (invoice_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invoiceId, it.product_name || '', it.size || '', price, qty, it.accessory || '', it.taxable]
      );
    }

    const { rows: rateRows } = await client.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);

    const nonTaxableTotal = total - taxableTotal;
    let finalTotal;

    if (discType === 'amount') {
      const baseGrand = taxableTotal * (1 + taxRate) + nonTaxableTotal;
      const maxDisc = clamp(discVal, 0, baseGrand);
      finalTotal = Math.max(0, baseGrand - maxDisc);
    } else {
      const pct = clamp(discVal, 0, 100) / 100;
      const taxableAfter = taxableTotal * (1 - pct);
      const nonTaxAfter  = nonTaxableTotal * (1 - pct);
      const taxAfter     = taxableAfter * taxRate;
      finalTotal = taxableAfter + nonTaxAfter + taxAfter;
    }

    await client.query(
      `UPDATE invoices SET total = $1 WHERE id = $2 AND user_id = $3`,
      [finalTotal, invoiceId, userId]
    );

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
