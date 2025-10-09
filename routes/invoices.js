// backend/routes/invoices.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
// If you mount authenticate/subscription in index.js, you don't need router.use(authenticate) here.

const clamp = (v, min, max) => Math.min(Math.max(Number(v) || 0, min), max);
const toString = (v) => (v == null ? '' : String(v));
const toBool = (v, def = true) => {
  if (typeof v === 'boolean') return v;
  if (v == null) return def;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return !['false', '0', 'no', 'off'].includes(v.toLowerCase());
  return def;
};

/**
 * POST /api/invoices
 * Inserts one row per selection (no dedup), allows display_name override.
 */
router.post('/', async (req, res) => {
  const {
    customer_id,
    customer_info,
    variationItems,
    customItems,
    discount_type,
    discount_value,
    notes,
    source_estimate_id,
  } = req.body || {};
  const userId = req.user.id;

  let discType = String(discount_type || '').toLowerCase() === 'percent' ? 'percent' : 'amount';
  let discVal = Number(discount_value) || 0;
  discVal = discType === 'percent' ? clamp(discVal, 0, 100) : clamp(discVal, 0, 1e12);

  const cleanNotes = toString(notes).slice(0, 2000);
  const srcEstId = Number(source_estimate_id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const safeCustomer = typeof customer_info === 'object' ? { ...customer_info } : {};
    if (customer_id != null && safeCustomer.id == null) safeCustomer.id = customer_id;

    const { rows: hdr } = await client.query(
      `INSERT INTO invoices (user_id, customer_info, invoice_date, total, discount_type, discount_value, notes)
       VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'), 0, $3, $4, $5)
       RETURNING id`,
      [userId, safeCustomer, discType, discVal, cleanNotes]
    );
    const invoiceId = hdr[0].id;

    let taxableSubtotal = 0;
    let nonTaxableSubtotal = 0;

    // Built-in lines (already priced by client or previous conversion)
    for (const it of (Array.isArray(variationItems) ? variationItems : [])) {
      const variationId = Number(it.variation_id ?? it.variationId);
      if (!Number.isFinite(variationId)) continue;

      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const price = Number(it.price) || 0;
      const taxable = toBool(it.taxable, true);
      const displayName = toString(it.display_name || it.product_name || '').trim() || null;

      const line = price * qty;
      (taxable ? (taxableSubtotal += line) : (nonTaxableSubtotal += line));

      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, product_variation_id, quantity, price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invoiceId, variationId, qty, price, taxable, displayName]
      );
    }

    // Custom lines
    for (const it of (Array.isArray(customItems) ? customItems : [])) {
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const price = Number(it.price) || 0;
      const taxable = toBool(it.taxable, true);
      const line = price * qty;

      (taxable ? (taxableSubtotal += line) : (nonTaxableSubtotal += line));

      await client.query(
        `INSERT INTO custom_invoice_items
           (invoice_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          invoiceId,
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
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate FROM store_info WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);

    // Final total (respect discount rules)
    let finalTotal;
    if (discType === 'amount') {
      const baseGrand = taxableSubtotal * (1 + taxRate) + nonTaxableSubtotal;
      finalTotal = Math.max(0, baseGrand - clamp(discVal, 0, 1e12));
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

    // If created from an estimate, delete that estimate atomically
    if (Number.isFinite(srcEstId)) {
      const { rowCount: own } = await client.query(
        `SELECT 1 FROM estimates WHERE id = $1 AND user_id = $2`,
        [srcEstId, userId]
      );
      if (own > 0) {
        await client.query(`DELETE FROM estimate_items WHERE estimate_id = $1`, [srcEstId]);
        await client.query(`DELETE FROM custom_estimate_items WHERE estimate_id = $1`, [srcEstId]);
        await client.query(`DELETE FROM estimates WHERE id = $1 AND user_id = $2`, [srcEstId, userId]);
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Invoice saved', invoiceId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Invoices POST failed:', error);
    res.status(500).json({ error: 'Failed to save invoice' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/invoices — headers only
 */
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const search = req.query.q ? `%${req.query.q}%` : null;
  const customerId = req.query.customer_id ? String(req.query.customer_id) : null;

  try {
    let sql, params;

    if (customerId) {
      sql = `
        SELECT
          inv.id,
          inv.customer_info,
          inv.invoice_date,
          ROUND(inv.total, 2) AS total,
          inv.discount_type,
          inv.discount_value,
          inv.notes
        FROM invoices inv
        WHERE inv.user_id = $1
          AND (inv.customer_info::jsonb)->>'id' = $2
        ORDER BY inv.invoice_date DESC
      `;
      params = [userId, customerId];
    } else if (search) {
      sql = `
        SELECT
          inv.id,
          inv.customer_info,
          inv.invoice_date,
          ROUND(inv.total, 2) AS total,
          inv.discount_type,
          inv.discount_value,
          inv.notes
        FROM invoices inv
        WHERE inv.user_id = $1
          AND (
            ((inv.customer_info::jsonb)->>'name')    ILIKE $2 OR
            ((inv.customer_info::jsonb)->>'company') ILIKE $2 OR
            ((inv.customer_info::jsonb)->>'email')   ILIKE $2 OR
            ((inv.customer_info::jsonb)->>'phone')   ILIKE $2
          )
        ORDER BY inv.invoice_date DESC
      `;
      params = [userId, search];
    } else {
      sql = `
        SELECT
          inv.id,
          inv.customer_info,
          inv.invoice_date,
          ROUND(inv.total, 2) AS total,
          inv.discount_type,
          inv.discount_value,
          inv.notes
        FROM invoices inv
        WHERE inv.user_id = $1
        ORDER BY inv.invoice_date DESC
      `;
      params = [userId];
    }

    const invoices = await pool.query(sql, params);
    res.json(invoices.rows);
  } catch (error) {
    console.error('❌ Invoices GET failed:', error);
    res.status(500).json({ error: 'Internal server error', where: 'Invoices GET failed' });
  }
});

/** GET /api/invoices/:id — header */
router.get('/:id', async (req, res) => {
  const invoiceId = req.params.id;
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `
      SELECT id,
             customer_info,
             invoice_date,
             ROUND(total, 2) AS total,
             discount_type,
             discount_value,
             notes
        FROM invoices
       WHERE id = $1 AND user_id = $2
      `,
      [invoiceId, userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Invoice not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Invoice GET failed:', err);
    res.status(500).json({ error: 'Failed to load invoice' });
  }
});

/** GET /api/invoices/:id/items — NO DEDUP, includes line_id */
router.get('/:id/items', async (req, res) => {
  const invoiceId = req.params.id;
  const userId = req.user.id;

  try {
    const check = await pool.query(
      `SELECT 1 FROM invoices WHERE id = $1 AND user_id = $2`,
      [invoiceId, userId]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({ error: 'Access denied: invoice does not belong to user.' });
    }

    const { rows: variationItems } = await pool.query(
  `
  SELECT
    ii.id AS line_id,
    ii.product_variation_id                              AS variation_id,
    COALESCE(ii.display_name, p.name, 'Item')            AS product_name,
    COALESCE(pv.size, '')                                 AS size,
    COALESCE(ii.price, pv.price, 0)::numeric(12,2)        AS price,
    ii.quantity,
    COALESCE(ii.taxable, TRUE)                            AS taxable,
    COALESCE(pv.accessory, '')                            AS accessory
  FROM invoice_items ii
  LEFT JOIN product_variations pv ON ii.product_variation_id = pv.id
  LEFT JOIN products p            ON pv.product_id = p.id
  WHERE ii.invoice_id = $1
  ORDER BY ii.id ASC
  `,
  [invoiceId]
);


    const { rows: customItems } = await pool.query(
      `SELECT
         id AS line_id, product_name, size, price, quantity, accessory,
         (CASE WHEN taxable IN (TRUE, 'true', 1) THEN TRUE ELSE FALSE END) AS taxable
       FROM custom_invoice_items
       WHERE invoice_id = $1
       ORDER BY id ASC`,
      [invoiceId]
    );

    const combinedItems = [
      ...variationItems.map(v => ({
        type: 'variation',
        line_id: v.line_id,
        variation_id: v.variation_id,
        product_name: v.product_name,
        size: v.size,
        price: v.price,
        quantity: v.quantity,
        accessory: v.accessory,
        taxable: !!v.taxable,
      })),
      ...customItems.map(c => ({
        type: 'custom',
        line_id: c.line_id,
        variation_id: null,
        product_name: c.product_name,
        size: c.size,
        price: c.price,
        quantity: c.quantity,
        accessory: c.accessory,
        taxable: !!c.taxable,
      })),
    ];

    res.json(combinedItems);
  } catch (err) {
    console.error('❌ Invoices items GET failed:', err);
    res.status(500).json({ error: 'Failed to load invoice items' });
  }
});

/** DELETE /api/invoices/:id */
router.delete('/:id', async (req, res) => {
  const invoiceId = req.params.id;
  const userId = req.user.id;

  try {
    const check = await pool.query(
      `SELECT 1 FROM invoices WHERE id = $1 AND user_id = $2`,
      [invoiceId, userId]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({ error: 'Access denied: invoice does not belong to user.' });
    }

    await pool.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);
    await pool.query(`DELETE FROM custom_invoice_items WHERE invoice_id = $1`, [invoiceId]);
    await pool.query(`DELETE FROM invoices WHERE id = $1 AND user_id = $2`, [invoiceId, userId]);

    res.json({ message: 'Invoice deleted' });
  } catch (err) {
    console.error('❌ Invoices DELETE failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
