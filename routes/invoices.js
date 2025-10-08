const express = require('express');
const router = express.Router();
const pool = require('../db');

// NOTE: auth/subscription guards assumed applied at mount time in index.js

const clamp = (v, min, max) => Math.min(Math.max(Number(v) || 0, min), max);
const toString = (v) => (v == null ? '' : String(v));

/**
 * POST /api/invoices
 * Creates a new invoice for the authenticated user.
 * - Stores customer_id inside customer_info JSON for future exact matching.
 * - Computes total using user's tax_rate (fallback 0.06).
 * - Persists discount_type ('amount' | 'percent') and discount_value (number).
 * - Persists notes (up to ~2000 chars).
 */
router.post('/', async (req, res) => {
  const {
    customer_id,
    customer_info,
    variationItems,
    customItems,
    discount_type,   // 'amount' | 'percent' (optional)
    discount_value,  // number (optional)
    notes            // string (optional)
  } = req.body || {};

  const userId = req.user.id;

  // normalize customer_info (accept object or JSON string)
  const toObject = (val) => {
    if (!val) return {};
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return {}; }
    }
    return typeof val === 'object' ? { ...val } : {};
  };

  // sanitize discount
  let discType = discount_type === 'percent' ? 'percent' : 'amount';
  let discVal = Number(discount_value) || 0;
  if (discType === 'percent') {
    discVal = clamp(discVal, 0, 100);
  } else {
    discVal = clamp(discVal, 0, 1e12);
  }

  // sanitize notes (no hard cap in invoices, but keep reasonable)
  const cleanNotes = toString(notes).slice(0, 2000);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Keep a stable link to the customer by embedding id in the JSON blob
    const safeCustomerInfo = toObject(customer_info);
    if (customer_id != null && safeCustomerInfo.id == null) {
      safeCustomerInfo.id = customer_id;
    }

    // Insert invoice header (total=0 initially); persist discount columns and notes
    const { rows: hdrRows } = await client.query(
      `INSERT INTO invoices (user_id, customer_info, invoice_date, total, discount_type, discount_value, notes)
       VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'), $3, $4, $5, $6)
       RETURNING id`,
      [userId, safeCustomerInfo, 0, discType, discVal, cleanNotes]
    );
    const invoiceId = hdrRows[0].id;

    let total = 0;         // subtotal (taxable + non-taxable)
    let taxableTotal = 0;  // taxable subtotal only

    // Variation items
    for (const item of (variationItems || [])) {
      const qty = Number(item.quantity || 1);
      const price = Number(item.price || 0);
      const line = price * qty;
      total += line;

      const isTaxable = item.taxable !== undefined ? !!item.taxable : true;
      if (isTaxable) taxableTotal += line;

      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, product_variation_id, quantity, price, taxable)
         VALUES ($1, $2, $3, $4, $5)`,
        [invoiceId, item.variation_id, qty, price, isTaxable]
      );
    }

    // Custom items
    for (const item of (customItems || [])) {
      const qty = Number(item.quantity || 1);
      const price = Number(item.price || 0);
      const line = price * qty;
      total += line;

      const isTaxable = item.taxable !== undefined ? !!item.taxable : true;
      if (isTaxable) taxableTotal += line;

      await client.query(
        `INSERT INTO custom_invoice_items
           (invoice_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          invoiceId,
          item.product_name || '',
          item.size || '',
          price,
          qty,
          item.accessory || '',
          isTaxable,
        ]
      );
    }

    // Pull user's tax rate (default 6%)
    const { rows: rateRows } = await client.query(
      `SELECT COALESCE(tax_rate, 0.06) AS tax_rate
         FROM store_info
        WHERE user_id = $1`,
      [userId]
    );
    const taxRate = Number(rateRows[0]?.tax_rate ?? 0.06);

    // Compute final total with discount rules
    const nonTaxableTotal = total - taxableTotal;
    let finalTotal;

    if (discType === 'amount') {
      // $ discount: subtotals & tax are computed from original amounts; discount subtracts from grand total.
      const baseGrand = taxableTotal * (1 + taxRate) + nonTaxableTotal;
      const maxDisc = clamp(discVal, 0, baseGrand);
      finalTotal = Math.max(0, baseGrand - maxDisc);
    } else {
      // % discount: apply pct to both subtotals; tax computed on discounted taxable subtotal.
      const pct = clamp(discVal, 0, 100) / 100;
      const taxableAfter = taxableTotal * (1 - pct);
      const nonTaxAfter  = nonTaxableTotal * (1 - pct);
      const taxAfter = taxableAfter * taxRate;
      finalTotal = taxableAfter + nonTaxAfter + taxAfter;
    }

    await client.query(
      `UPDATE invoices
          SET total = $1
        WHERE id = $2 AND user_id = $3`,
      [finalTotal, invoiceId, userId]
    );

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
 * GET /api/invoices
 * Scopes strictly by user_id.
 * Supports:
 *  - ?customer_id=<id> : exact match by embedded customer_info.id
 *  - ?q=<text>        : fuzzy match on name/company/email/phone
 *  - no params        : returns all invoices for the user
 * Returns discount_type, discount_value & notes as well.
 */
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const search = req.query.q ? `%${req.query.q}%` : null;
  const customerId = req.query.customer_id ? String(req.query.customer_id) : null;

  try {
    let sql;
    let params;

    if (customerId) {
      // Exact match by embedded id (fast & precise)
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
      // Fuzzy search
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
      // All invoices for the user
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

    console.time('invoices-db');
    const invoices = await pool.query(sql, params);
    console.timeEnd('invoices-db');

    // Include items (user-scoped join to prevent cross-user leakage)
    const data = [];
    for (const inv of invoices.rows) {
      console.time(`invoice-items-${inv.id}`);
      const { rows: items } = await pool.query(
        `
        SELECT ii.quantity, ii.price, ii.taxable
          FROM invoice_items ii
          JOIN invoices inv ON inv.id = ii.invoice_id
         WHERE ii.invoice_id = $1 AND inv.user_id = $2
        UNION ALL
        SELECT ci.quantity, ci.price, ci.taxable
          FROM custom_invoice_items ci
          JOIN invoices inv2 ON inv2.id = ci.invoice_id
         WHERE ci.invoice_id = $1 AND inv2.user_id = $2
        `,
        [inv.id, userId]
      );
      console.timeEnd(`invoice-items-${inv.id}`);

      data.push({ ...inv, items });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Invoices GET failed:', error);
    res.status(500).json({ error: 'Internal server error while fetching invoices' });
  }
});

/**
 * GET /api/invoices/:id
 * Returns a single invoice header (including discount fields & notes) after verifying ownership.
 */
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

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Invoice GET failed:', err);
    res.status(500).json({ error: 'Failed to load invoice' });
  }
});

/**
 * PATCH /api/invoices/:id/notes
 * Updates the notes for a single invoice.
 * Body: { notes: string }
 */
router.patch('/:id/notes', async (req, res) => {
  const invoiceId = req.params.id;
  const userId = req.user.id;
  const cleanNotes = toString(req.body?.notes).slice(0, 2000);

  try {
    const check = await pool.query(
      `SELECT 1 FROM invoices WHERE id = $1 AND user_id = $2`,
      [invoiceId, userId]
    );
    if (check.rowCount === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    await pool.query(
      `UPDATE invoices SET notes = $1 WHERE id = $2 AND user_id = $3`,
      [cleanNotes, invoiceId, userId]
    );

    res.json({ message: 'Notes updated' });
  } catch (err) {
    console.error('❌ Update invoice notes failed:', err);
    res.status(500).json({ error: 'Failed to update notes' });
  }
});

/**
 * GET /api/invoices/:id/items
 * Returns items for a specific invoice after verifying ownership.
 */
router.get('/:id/items', async (req, res) => {
  const invoiceId = req.params.id;
  const userId = req.user.id;

  try {
    // Check ownership
    const check = await pool.query(
      `SELECT 1 FROM invoices WHERE id = $1 AND user_id = $2`,
      [invoiceId, userId]
    );
    if (check.rowCount === 0) {
      return res.status(403).json({
        error: 'Access denied: invoice does not belong to user.',
      });
    }

    const { rows: variationItems } = await pool.query(
      `SELECT
         ii.product_variation_id as variation_id,
         pv.size,
         ii.price,
         ii.quantity,
         ii.taxable,
         pv.accessory,
         p.name as product_name
       FROM invoice_items ii
       JOIN product_variations pv ON ii.product_variation_id = pv.id
       JOIN products p ON pv.product_id = p.id
       WHERE ii.invoice_id = $1`,
      [invoiceId]
    );

    const { rows: customItems } = await pool.query(
      `SELECT product_name, size, price, quantity, accessory, taxable
         FROM custom_invoice_items
        WHERE invoice_id = $1`,
      [invoiceId]
    );

    const combinedItems = [
      ...variationItems.map(v => ({
        type: 'variation',
        product_name: v.product_name,
        size: v.size,
        price: v.price,
        quantity: v.quantity,
        accessory: v.accessory,
        taxable: v.taxable,
        variation_id: v.variation_id,
      })),
      ...customItems.map(c => ({
        type: 'custom',
        product_name: c.product_name,
        size: c.size,
        price: c.price,
        quantity: c.quantity,
        accessory: c.accessory,
        taxable: c.taxable,
        variation_id: null,
      })),
    ];

    res.json(combinedItems);
  } catch (err) {
    console.error('❌ Invoices items GET failed:', err);
    res.status(500).json({ error: 'Failed to load invoice items' });
  }
});

/**
 * DELETE /api/invoices/:id
 * Deletes an invoice (and its items) after verifying ownership.
 */
router.delete('/:id', async (req, res) => {
  const invoiceId = req.params.id;
  const userId = req.user.id;

  try {
    const check = await pool.query(
      `SELECT 1 FROM invoices WHERE id = $1 AND user_id = $2`,
      [invoiceId, userId]
    );
    if (check.rowCount === 0) {
      return res
        .status(403)
        .json({ error: 'Access denied: invoice does not belong to user.' });
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
