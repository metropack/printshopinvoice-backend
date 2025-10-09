const express = require('express');
const router = express.Router();
const pool = require('../db');

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

/** POST /api/invoices */
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

  const toObject = (val) => {
    if (!val) return {};
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return {}; }
    }
    return typeof val === 'object' ? { ...val } : {};
  };

  let discType = discount_type === 'percent' ? 'percent' : 'amount';
  let discVal = Number(discount_value) || 0;
  if (discType === 'percent') discVal = clamp(discVal, 0, 100);
  else discVal = clamp(discVal, 0, 1e12);

  const cleanNotes = toString(notes).slice(0, 2000);
  const srcEstId = Number(source_estimate_id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const safeCustomerInfo = toObject(customer_info);
    if (customer_id != null && safeCustomerInfo.id == null) {
      safeCustomerInfo.id = customer_id;
    }

    const { rows: hdrRows } = await client.query(
      `INSERT INTO invoices (user_id, customer_info, invoice_date, total, discount_type, discount_value, notes)
       VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'), $3, $4, $5, $6)
       RETURNING id`,
      [userId, safeCustomerInfo, 0, discType, discVal, cleanNotes]
    );
    const invoiceId = hdrRows[0].id;

    let total = 0;
    let taxableTotal = 0;

    // Built-ins (use provided overrides; no pv.accessory anywhere)
    for (const item of (variationItems || [])) {
      const qty = Number(item.quantity || 1);
      const price = Number(item.price || 0);
      const line = price * qty;
      total += line;

      const isTaxable = boolish(item.taxable, true);
      if (isTaxable) taxableTotal += line;

      await client.query(
        `INSERT INTO invoice_items
           (invoice_id, product_variation_id, quantity, price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invoiceId, item.variation_id, qty, price, isTaxable, toString(item.display_name || item.product_name)]
      );
    }

    // Custom items
    for (const item of (customItems || [])) {
      const qty = Number(item.quantity || 1);
      const price = Number(item.price || 0);
      const line = price * qty;
      total += line;

      const isTaxable = boolish(item.taxable, true);
      if (isTaxable) taxableTotal += line;

      await client.query(
        `INSERT INTO custom_invoice_items
           (invoice_id, product_name, size, price, quantity, accessory, taxable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          invoiceId,
          toString(item.product_name),
          toString(item.size),
          price,
          qty,
          toString(item.accessory),
          isTaxable,
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
      const taxAfter = taxableAfter * taxRate;
      finalTotal = taxableAfter + nonTaxAfter + taxAfter;
    }

    await client.query(
      `UPDATE invoices
          SET total = $1
        WHERE id = $2 AND user_id = $3`,
      [finalTotal, invoiceId, userId]
    );

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
    return sendDbError(res, error, 'Invoices POST failed');
  } finally {
    client.release();
  }
});

/** GET /api/invoices */
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const search = req.query.q ? `%${req.query.q}%` : null;
  const customerId = req.query.customer_id ? String(req.query.customer_id) : null;

  try {
    let sql;
    let params;

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
    return sendDbError(res, error, 'Invoices GET failed');
  }
});

/** GET /api/invoices/:id */
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
    return sendDbError(res, err, 'Invoice GET failed');
  }
});

/** GET /api/invoices/:id/items — prefer display_name; no pv.accessory */
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
      `SELECT
         ii.product_variation_id as variation_id,
         pv.size,
         ii.price,
         ii.quantity,
         ii.taxable,
         COALESCE(ii.display_name, p.name) AS product_name
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
        price: Number(v.price),
        quantity: v.quantity,
        accessory: null,
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
    return sendDbError(res, err, 'Invoices items GET failed');
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
      return res
        .status(403)
        .json({ error: 'Access denied: invoice does not belong to user.' });
    }

    await pool.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);
    await pool.query(`DELETE FROM custom_invoice_items WHERE invoice_id = $1`, [invoiceId]);
    await pool.query(`DELETE FROM invoices WHERE id = $1 AND user_id = $2`, [invoiceId, userId]);

    res.json({ message: 'Invoice deleted' });
  } catch (err) {
    return sendDbError(res, err, 'Invoices DELETE failed');
  }
});

module.exports = router;
