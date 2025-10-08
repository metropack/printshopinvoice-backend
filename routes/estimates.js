const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

router.use(authenticate);

const toString = (v) => (v == null ? '' : String(v));

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
    console.error('❌ Error fetching estimates:', err);
    res.status(500).json({ error: 'Failed to load estimates' });
  }
});

/**
 * POST /api/estimates - Create a new estimate (only mine)
 * - Variation items: taxable by default
 * - Custom items: respects taxable flag
 * - Total uses the user's saved store tax rate (fallback 0.06)
 * - Persists notes (REQUIRED max 150 chars, trimmed)
 */
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { customer_id, customer_info, variationItems = [], customItems = [], notes } = req.body || {};

  let cleanNotes = toString(notes).trim();
  if (cleanNotes.length > 150) {
    return res.status(400).json({ error: 'Notes must be 150 characters or fewer.' });
  }

  try {
    const insertEstimate = await pool.query(
      `INSERT INTO estimates (user_id, customer_id, customer_info, estimate_date, total, notes)
       VALUES ($1, $2, $3, NOW(), $4, $5)
       RETURNING id`,
      [userId, customer_id ?? null, customer_info || {}, 0, cleanNotes]
    );

    const estimateId = insertEstimate.rows[0].id;
    let totalTaxable = 0;
    let totalNonTaxable = 0;

    // Variation items (taxable = true)
    for (const item of variationItems) {
      const priceRes = await pool.query(
        `SELECT price FROM product_variations WHERE id = $1`,
        [item.variation_id]
      );
      const price = Number(priceRes.rows[0]?.price || 0);
      const qty = Number(item.quantity || 1);
      const line = price * qty;

      totalTaxable += line; // variation lines considered taxable

      await pool.query(
        `INSERT INTO estimate_items (estimate_id, product_variation_id, quantity)
         VALUES ($1, $2, $3)`,
        [estimateId, item.variation_id, qty]
      );
    }

    // Custom items (respect taxable)
    for (const item of customItems) {
      const qty = Number(item.quantity || 1);
      const price = Number(item.price || 0);
      const line = price * qty;
      const taxable = item.taxable === true || item.taxable === 'true' || item.taxable === 1;

      if (taxable) totalTaxable += line;
      else totalNonTaxable += line;

      await pool.query(
        `INSERT INTO custom_estimate_items 
         (estimate_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          estimateId,
          item.product_name || '',
          item.size || '',
          price,
          qty,
          item.accessory || '',
          taxable
        ]
      );
    }

    // Use user's saved tax rate
    const { rows: rateRows } = await pool.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);

    const finalTotal = totalTaxable * (1 + taxRate) + totalNonTaxable;

    await pool.query(
      `UPDATE estimates SET total = $1 WHERE id = $2 AND user_id = $3`,
      [finalTotal, estimateId, userId]
    );

    res.status(201).json({ message: 'Estimate saved', estimateId });
  } catch (err) {
    console.error("❌ Error saving estimate:", err);
    res.status(500).json({ error: 'Failed to save estimate' });
  }
});

/**
 * PUT /api/estimates/:id - Update an existing estimate in place
 * - Replaces items, recomputes total with user's tax rate
 * - Updates notes (still max 150 chars)
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

    // Update header (also refresh date so it bubbles to the top), include notes
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

    let totalTaxable = 0;
    let totalNonTaxable = 0;

    // Variation items (taxable = true)
    for (const item of variationItems) {
      const qty = Number(item.quantity || 1);

      const priceRes = await client.query(
        `SELECT price FROM product_variations WHERE id = $1`,
        [item.variation_id]
      );
      const price = Number(priceRes.rows[0]?.price || 0);

      totalTaxable += price * qty;

      await client.query(
        `INSERT INTO estimate_items (estimate_id, product_variation_id, quantity)
         VALUES ($1, $2, $3)`,
        [estimateId, item.variation_id, qty]
      );
    }

    // Custom items (respect taxable)
    for (const it of customItems) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.price || 0);
      const taxable = it.taxable === true || it.taxable === 'true' || it.taxable === 1;

      if (taxable) totalTaxable += price * qty;
      else totalNonTaxable += price * qty;

      await client.query(
        `INSERT INTO custom_estimate_items
           (estimate_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [estimateId, it.product_name || '', it.size || '', price, qty, it.accessory || '', taxable]
      );
    }

    // Recompute total with user's tax rate
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
    console.error('❌ Error updating estimate:', err);
    res.status(500).json({ error: 'Failed to update estimate' });
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
    console.error("❌ Error updating estimate notes:", err);
    res.status(500).json({ error: 'Failed to update notes' });
  }
});

/**
 * GET /api/estimates/:id/items - Load estimate items (only mine)
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
         pv.price,
         pv.accessory,
         p.name as product_name,
         ei.quantity
       FROM estimate_items ei
       JOIN product_variations pv ON ei.product_variation_id = pv.id
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
        taxable: true,
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
    console.error("❌ Failed to load estimate items:", err);
    res.status(500).json({ error: 'Failed to load estimate items' });
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
    console.error("❌ Error deleting estimate:", err);
    res.status(500).json({ error: 'Internal server error' });
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
    console.error("❌ Error searching customers:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/estimates/:id/convert-to-invoice  (atomic)
 * - Carries over estimate notes into invoice notes.
 */
router.post('/:id/convert-to-invoice', async (req, res) => {
  const estimateId = req.params.id;
  const userId = req.user.id;

  if (!/^\d+$/.test(String(estimateId))) {
    return res.status(400).json({ error: 'Invalid estimate id' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure ownership & load estimate header
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
    const estNotes = toString(estRows[0].notes || '').slice(0, 2000);

    // Load estimate items
    const { rows: variationItems } = await client.query(
      `SELECT ei.product_variation_id AS variation_id, ei.quantity,
              pv.price, pv.size, pv.accessory, p.name AS product_name
         FROM estimate_items ei
         JOIN product_variations pv ON pv.id = ei.product_variation_id
         JOIN products p ON p.id = pv.product_id
        WHERE ei.estimate_id = $1`,
      [estimateId]
    );

    const { rows: customItems } = await client.query(
      `SELECT product_name, size, price, quantity, accessory,
              (CASE WHEN taxable IN (TRUE, 'true', 1) THEN TRUE ELSE FALSE END) AS taxable
         FROM custom_estimate_items
        WHERE estimate_id = $1`,
      [estimateId]
    );

    // Create invoice header (notes carried over). Discount fields left default/null here.
    const { rows: invHdr } = await client.query(
      `INSERT INTO invoices (user_id, customer_info, invoice_date, total, notes)
       VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'), 0, $3)
       RETURNING id`,
      [userId, customer_info, estNotes]
    );
    const invoiceId = invHdr[0].id;

    // Insert invoice items + compute totals
    let total = 0;
    let taxableTotal = 0;

    // Variation items → invoice_items (taxable by default)
    for (const it of variationItems) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.price || 0);
      const line = price * qty;
      total += line;
      taxableTotal += line;

      await client.query(
        `INSERT INTO invoice_items (invoice_id, product_variation_id, quantity, price, taxable)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoiceId, it.variation_id, qty, price, true]
      );
    }

    // Custom items → custom_invoice_items (preserve taxable flag)
    for (const it of customItems) {
      const qty = Number(it.quantity || 1);
      const price = Number(it.price || 0);
      const line = price * qty;
      total += line;
      if (it.taxable) taxableTotal += line;

      await client.query(
        `INSERT INTO custom_invoice_items (invoice_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invoiceId, it.product_name || '', it.size || '', price, qty, it.accessory || '', it.taxable]
      );
    }

    // Apply this user's tax rate
    const { rows: rateRows } = await client.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);

    const finalTotal = Number.isFinite(total)
      ? taxableTotal * (1 + taxRate) + (total - taxableTotal)
      : 0;

    await client.query(
      `UPDATE invoices
          SET total = $1
        WHERE id = $2 AND user_id = $3`,
      [finalTotal, invoiceId, userId]
    );

    // Delete the estimate (children first)
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
