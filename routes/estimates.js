// backend/routes/estimates.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');
const { sendMail } = require('../utils/mailer');

router.use(authenticate);

const clamp = (v, min, max) => Math.min(Math.max(Number(v) || 0, min), max);
const toString = (v) => (v == null ? '' : String(v));
const toBool = (v, def = true) => {
  if (typeof v === 'boolean') return v;
  if (v == null) return def;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return !['false', '0', 'no', 'off'].includes(v.toLowerCase());
  return def;
};

/** GET /api/estimates — list, mine only */
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
 * POST /api/estimates
 * - one row per built-in selection (NO DEDUP)
 * - allows per-line overrides: unit_price, taxable, display_name
 * - custom lines preserved with taxable flag
 * - notes ≤ 150 chars
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

    const { rows: estRows } = await client.query(
      `INSERT INTO estimates (user_id, customer_id, customer_info, estimate_date, total, notes)
       VALUES ($1, $2, $3, NOW(), 0, $4)
       RETURNING id`,
      [userId, customer_id ?? null, customer_info || {}, cleanNotes]
    );
    const estimateId = estRows[0].id;

    let taxableSubtotal = 0;
    let nonTaxableSubtotal = 0;

    // Built-in lines with overrides
    for (const it of (Array.isArray(variationItems) ? variationItems : [])) {
      const variationId = Number(it.variation_id ?? it.variationId);
      if (!Number.isFinite(variationId)) continue;

      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);

      const overridePrice = it.unit_price != null ? Number(it.unit_price) : Number(it.price);
      const hasOverridePrice = Number.isFinite(overridePrice);
      const displayName = toString(it.display_name || it.product_name || '').trim() || null;
      const taxable = toBool(it.taxable, true);

      let lineUnitPrice = hasOverridePrice ? overridePrice : null;
      if (lineUnitPrice == null) {
        const { rows: priceRows } = await client.query(
          `SELECT price FROM product_variations WHERE id = $1`,
          [variationId]
        );
        lineUnitPrice = Number(priceRows[0]?.price || 0);
      }

      const lineTotal = lineUnitPrice * qty;
      (taxable ? (taxableSubtotal += lineTotal) : (nonTaxableSubtotal += lineTotal));

      await client.query(
        `INSERT INTO estimate_items
           (estimate_id, product_variation_id, quantity, unit_price, taxable, display_name)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [estimateId, variationId, qty, lineUnitPrice, taxable, displayName]
      );
    }

    // Custom lines
    for (const it of (Array.isArray(customItems) ? customItems : [])) {
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const price = Number(it.price) || 0;
      const taxable = toBool(it.taxable, true);

      (taxable ? (taxableSubtotal += price * qty) : (nonTaxableSubtotal += price * qty));

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

    // tax
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

/** PUT /api/estimates/:id — replace children (keeps duplicates) */
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

    for (const it of (Array.isArray(variationItems) ? variationItems : [])) {
      const variationId = Number(it.variation_id ?? it.variationId);
      if (!Number.isFinite(variationId)) continue;

      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      const overridePrice = it.unit_price != null ? Number(it.unit_price) : Number(it.price);
      const hasOverridePrice = Number.isFinite(overridePrice);
      const displayName = toString(it.display_name || it.product_name || '').trim() || null;
      const taxable = toBool(it.taxable, true);

      let lineUnitPrice = hasOverridePrice ? overridePrice : null;
      if (lineUnitPrice == null) {
        const { rows: priceRows } = await client.query(
          `SELECT price FROM product_variations WHERE id = $1`,
          [variationId]
        );
        lineUnitPrice = Number(priceRows[0]?.price || 0);
      }

      const lineTotal = lineUnitPrice * qty;
      (taxable ? (taxableSubtotal += lineTotal) : (nonTaxableSubtotal += lineTotal));

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

      (taxable ? (taxableSubtotal += price * qty) : (nonTaxableSubtotal += price * qty));

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

/** GET /api/estimates/:id/items — NO DEDUP, overrides coalesced, ordered by line id */
router.get('/:id/items', async (req, res) => {
  const estimateId = req.params.id;
  const userId = req.user.id;

  try {
    const own = await pool.query(
      `SELECT 1 FROM estimates WHERE id=$1 AND user_id=$2`,
      [estimateId, userId]
    );
    if (own.rowCount === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Built-in (variation) lines
    const { rows: variationItems } = await pool.query(
      `
      SELECT
        ei.product_variation_id                             AS variation_id,
        COALESCE(pv.size, '')                               AS size,
        COALESCE(ei.unit_price, pv.price, 0)::numeric(12,2) AS price,
        ei.quantity,
        COALESCE(ei.taxable, TRUE)                          AS taxable,
        COALESCE(pv.accessory, '')                          AS accessory,
        COALESCE(ei.display_name, p.name, 'Item')           AS product_name
      FROM estimate_items ei
      LEFT JOIN product_variations pv ON pv.id = ei.product_variation_id
      LEFT JOIN products p            ON p.id = pv.product_id
      WHERE ei.estimate_id = $1
      ORDER BY ei.id ASC
      `,
      [estimateId]
    );

    const { rows: customItems } = await pool.query(
      `
      SELECT
        product_name,
        size,
        price::numeric(12,2)  AS price,
        quantity,
        accessory,
        COALESCE(taxable, TRUE) AS taxable
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
 * POST /api/estimates/:id/convert-to-invoice
 * Keeps duplicates 1:1, carries edited name/price/taxable.
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

    // Copy variation lines with overrides coalesced
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

    // Custom estimate lines
    const { rows: custItems } = await client.query(
      `SELECT
         product_name,
         size,
         price::numeric(12,2) AS price,
         quantity,
         accessory,
         COALESCE(taxable, TRUE) AS taxable
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

      (it.taxable ? (taxableSubtotal += line) : (nonTaxableSubtotal += line));

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

      (it.taxable ? (taxableSubtotal += line) : (nonTaxableSubtotal += line));

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

    // Remove estimate
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

/**
 * POST /api/estimates/:id/email
 * Send an estimate PDF to the customer using store info as Reply-To (if present).
 * Body: { pdf_base64, to?, subject?, message_html?, message_text?, reply_to? }
 */
router.post('/:id/email', async (req, res) => {
  const userId = req.user.id;
  const estimateId = Number(req.params.id);

  try {
    const hdr = await pool.query(
      'SELECT customer_info FROM estimates WHERE id = $1 AND user_id = $2',
      [estimateId, userId]
    );
    if (hdr.rowCount === 0) return res.status(403).json({ error: 'Access denied' });

    const customer = hdr.rows[0]?.customer_info || {};
    const fallbackTo = (customer.email || '').trim();
    const {
      to = fallbackTo,
      pdf_base64,
      subject,
      message_html,
      message_text,
      reply_to,
    } = req.body || {};

    if (!to) return res.status(400).json({ error: 'Customer email is missing.' });
    if (!pdf_base64) return res.status(400).json({ error: 'Missing pdf_base64' });

    // Store Reply-To
    const s = await pool.query(
      `SELECT email, name FROM store_info WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const storeEmail = (s.rows[0]?.email || '').trim();
    const storeName = (s.rows[0]?.name || '').trim();
    const replyToAddr =
      reply_to || (storeEmail ? `${storeName ? storeName + ' ' : ''}<${storeEmail}>` : undefined);

    // Base64 → Buffer
    const clean = String(pdf_base64).replace(/^data:application\/pdf;base64,/, '');
    const pdfBuffer = Buffer.from(clean, 'base64');

        const defaultSubject = subject || `Estimate #${estimateId} from ${storeName || 'Print Shop'}`;
    const defaultText = message_text || 'Please find your estimate attached.';
    const defaultHtml = message_html || `<p>Please find your estimate attached.</p>`;

    await sendMail({
      from: 'receipts@printshopinvoice.com',        // <-- add this line
      to,
      subject: defaultSubject,
      text: defaultText,
      html: defaultHtml,
      replyTo: replyToAddr,
      attachments: [{ filename: `estimate-${estimateId}.pdf`, content: pdfBuffer }],
    });

    res.json({ ok: true });

  } catch (err) {
    console.error('Email estimate failed:', err);
    res.status(500).json({ error: 'Failed to send email' });
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
    await pool.query(`DELETE FROM estimates WHERE id = $1 AND user_id = $2`, [estimateId, userId]);

    res.json({ message: 'Estimate deleted' });
  } catch (err) {
    console.error('❌ Error deleting estimate:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
