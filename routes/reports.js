const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

router.use(authenticate);

// ✅ GET Sales Report with taxable items
router.get('/sales', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const userId = req.user.id;

    let query = `
      SELECT id, customer_info, invoice_date, total
      FROM invoices
      WHERE user_id = $1
    `;
    const params = [userId];

    if (startDate) {
      params.push(startDate);
      query += ` AND invoice_date >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      query += ` AND invoice_date <= $${params.length}`;
    }

    query += ' ORDER BY invoice_date DESC';

    // ✅ Fetch invoices
    const invoices = await pool.query(query, params);

    const fullData = [];
    for (const invoice of invoices.rows) {
      // Variation items
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
        [invoice.id]
      );

      // Custom items
      const { rows: customItems } = await pool.query(
        `SELECT product_name, size, price, quantity, accessory, taxable
         FROM custom_invoice_items
         WHERE invoice_id = $1`,
        [invoice.id]
      );

      fullData.push({
        ...invoice,
        items: [
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
        ],
      });
    }

    res.json(fullData);
  } catch (err) {
    console.error('Error fetching sales report:', err);
    res.status(500).json({ error: 'Failed to fetch sales report' });
  }
});

module.exports = router;
