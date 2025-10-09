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

/** GET /api/estimates */
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

/** POST /api/estimates — supports per-line overrides for built-ins */
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

    const { rows: header } = await client.query(
      `INSERT INTO estimates (user_id, customer_id, customer_info, estimate_date, total, notes)
       VALUES ($1, $2, $3, NOW(), 0, $4)
       RETURNING id`,
      [userId, customer_id ?? null, customer_info || {}, cleanNotes]
    );
    const estimateId = header[0].id;

    let taxableSubtotal = 0;
    let nonTaxableSubtotal = 0;

    // Built-in items with overrides (NO pv.accessory here)
    for (const raw of variationItems) {
      if (!raw || !raw.variation_id) continue;

      const qty = Number(raw.quantity || 1);

      // Get canonical price + product name as fallback
      const { rows: pvRows } = await client.query(
        `SELECT pv.price, p.name AS product_name, pv.size
           FROM product_variations pv
           JOIN products p ON p.id = pv.product_id
          WHERE pv.id = $1`,
        [raw.variation_id]
      );
      const canonical = pvRows[0] || { price: 0, product_name: '', size: null };

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

    // Custom items (keep accessory)
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

    // Tax and total
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

/** PUT /api/estimates/:id — replace children (built-ins support overrides) */
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

    for (const raw of variationItems) {
      if (!raw || !raw.variation_id) continue;

      const qty = Number(raw.quantity || 1);

      const { rows: pvRows } = await client.query(
        `SELECT pv.price, p.name AS product_name, pv.size
           FROM product_variations pv
           JOIN products p ON p.id = pv.product_id
          WHERE pv.id = $1`,
        [raw.variation_id]
      );
      const canonical = pvRows[0] || { price: 0, product_name: '', size: null };

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

/** PATCH /api/estimates/:id/notes */
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

/** GET /api/estimates/:id/items — prefer overrides; no pv.accessory */
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
        accessory: null, // not available for variations anymore
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
        taxable: !!c.taxable,
        variation_id: null
      }))
    ];

    res.json(combinedItems);
  } catch (err) {
    return sendDbError(res, err, 'Failed to load estimate items');
  }
});

/** DELETE /api/estimates/:id */
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

/** GET /api/estimates/search/customers */
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

/** POST /api/estimates/:id/convert-to-invoice — carries overrides; no pv.accessory */
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
    const carriedNotes = toString(estRows[0].notes || '');
    const invNotes = toString(req.body?.notes ?? carriedNotes).slice(0, 2000);

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
