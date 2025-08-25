const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/products
 * Fetch base products with ONLY this user's NON-archived variations aggregated,
 * and EXCLUDE any base product the user archived.
 */
router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        p.id AS product_id,
        p.name,
        p.description,
        p.base_price,
        p.example_image,
        COALESCE(
          json_agg(
            json_build_object(
              'variation_id', v.id,
              'quantity',    v.quantity,
              'size',        v.size,
              'accessory',   v.accessory,
              'price',       v.price
            )
          ) FILTER (WHERE v.id IS NOT NULL),
          '[]'
        ) AS variations
      FROM products p
      -- hide products archived by this user
      LEFT JOIN user_archived_products upa
        ON upa.product_id = p.id
       AND upa.user_id = $1
      -- include only this user's NON-archived variations
      LEFT JOIN product_variations v
        ON v.product_id = p.id
       AND v.user_id   = $1
       AND COALESCE(v.archived, false) = false
      WHERE COALESCE(upa.archived, false) = false
      GROUP BY p.id
      ORDER BY p.id
      `,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    console.error('GET /api/products error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/products/:productId/variations
 * Create a new variation tied to the logged-in user.
 */
router.post('/:productId/variations', async (req, res) => {
  const userId = req.user.id;
  const { productId } = req.params;
  const { size, price, accessory, quantity } = req.body;

  if (size == null && quantity == null) {
    return res.status(400).json({ error: 'Quantity or size is required' });
  }
  if (price == null) {
    return res.status(400).json({ error: 'Price is required' });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO product_variations (product_id, user_id, quantity, size, price, accessory)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [productId, userId, quantity ?? null, size ?? null, price, accessory || 'None']
    );

    res.status(201).json({
      message: 'Variation added',
      variation: result.rows[0],
    });
  } catch (error) {
    console.error('POST /api/products/:productId/variations error:', error);
    res.status(500).json({ error: 'Failed to add variation' });
  }
});

/**
 * PUT /api/products/variations/:id/price
 * Update price of a variation for the logged-in user (only if not archived).
 */
router.put('/variations/:id/price', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const { price } = req.body;

  if (price == null) {
    return res.status(400).json({ error: 'Price is required' });
  }

  try {
    const result = await pool.query(
      `
      UPDATE product_variations
         SET price = $1
       WHERE id = $2
         AND user_id = $3
         AND COALESCE(archived, false) = false
       RETURNING *
      `,
      [price, id, userId]
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: 'Variation not found, not owned by you, or archived' });
    }

    res.json({
      message: 'Price updated successfully',
      variation: result.rows[0],
    });
  } catch (error) {
    console.error('PUT /api/products/variations/:id/price error:', error);
    res.status(500).json({ error: 'Failed to update price' });
  }
});

/**
 * DELETE /api/products/variations/:id
 * Soft-delete (archive) a variation for the logged-in user.
 */
router.delete('/variations/:id', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      UPDATE product_variations
         SET archived = true
       WHERE id = $1
         AND user_id = $2
         AND COALESCE(archived, false) = false
       RETURNING *
      `,
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: 'Variation not found, not owned by you, or already archived.' });
    }

    return res.json({
      message: 'Variation archived (hidden).',
      variation: result.rows[0],
    });
  } catch (error) {
    console.error('Archive variation error:', error);
    return res.status(500).json({ error: 'Failed to archive variation' });
  }
});

/**
 * POST /api/products/:productId/archive
 * Archive a whole product for the current user AND (optionally) mark all this user's
 * variations for that product as archived. GET /api/products will then hide it.
 */
router.post('/:productId/archive', async (req, res) => {
  const userId = req.user.id;
  const { productId } = req.params;

  try {
    await pool.query('BEGIN');

    // 1) Upsert into user_archived_products
    const upsert = await pool.query(
      `
      INSERT INTO user_archived_products (user_id, product_id, archived, archived_at)
      VALUES ($1, $2, true, NOW())
      ON CONFLICT (user_id, product_id)
      DO UPDATE SET archived = EXCLUDED.archived, archived_at = EXCLUDED.archived_at
      RETURNING *
      `,
      [userId, productId]
    );

    // 2) Also archive all of this user's variations for that product
    await pool.query(
      `
      UPDATE product_variations
         SET archived = true
       WHERE product_id = $1
         AND user_id = $2
         AND COALESCE(archived, false) = false
      `,
      [productId, userId]
    );

    await pool.query('COMMIT');

    res.json({
      message: 'Product archived for user (and all variations archived).',
      archived: upsert.rows[0],
    });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('POST /api/products/:productId/archive error:', error);
    res.status(500).json({ error: 'Failed to archive product' });
  }
});

module.exports = router;
