// routes/invoices.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// Option A applies `authenticate` + `subscriptionGuard` at mount time in index.js,
// so no per-file router.use(authenticate) is needed here.

/**
 * POST /api/invoices
 * Creates a new invoice for the authenticated user.
 * - Stores customer_id inside customer_info JSON for future exact matching.
 * - Computes total using user's tax_rate (fallback 0.06).
 */
router.post('/', async (req, res) => {
  const { customer_id, customer_info, variationItems, customItems } = req.body;
  const userId = req.user.id;

  // normalize customer_info (accept object or JSON string)
  const toObject = (val) => {
    if (!val) return {};
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return {}; }
    }
    return typeof val === 'object' ? { ...val } : {};
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Keep a stable link to the customer by embedding id in the JSON blob
    const safeCustomerInfo = toObject(customer_info);
    if (customer_id != null && safeCustomerInfo.id == null) {
      safeCustomerInfo.id = customer_id;
    }

    // Insert invoice header (total=0 initially)
    const { rows: hdrRows } = await client.query(
      `INSERT INTO invoices (user_id, customer_info, invoice_date, total)
       VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'), $3)
       RETURNING id`,
      [userId, safeCustomerInfo, 0]
    );
    const invoiceId = hdrRows[0].id;

    let total = 0;
    let taxableTotal = 0;

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

    const finalTotal = Number.isFinite(total)
      ? taxableTotal * (1 + taxRate) + (total - taxableTotal)
      : 0;

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
          ROUND(inv.total, 2) AS total
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
          ROUND(inv.total, 2) AS total
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
          ROUND(inv.total, 2) AS total
        FROM invoices inv
        WHERE inv.user_id = $1
        ORDER BY inv.invoice_date DESC
      `;
      params = [userId];
    }

    const invoices = await pool.query(sql, params);

    // Include items (user-scoped join to prevent cross-user leakage)
    const data = [];
    for (const inv of invoices.rows) {
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

      data.push({ ...inv, items });
    }

    res.json(data);
  } catch (error) {
    console.error('❌ Invoices GET failed:', error);
    res.status(500).json({ error: 'Internal server error while fetching invoices' });
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
