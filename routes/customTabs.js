// backend/routes/customTabs.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

// All routes require authentication
router.use(authenticate);

// --- helpers ---
function parseVariations(raw) {
  let arr = [];
  if (!raw) return { variations: [], taxable: true }; // default taxable true
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) arr = [];
  } catch {
    arr = [];
  }

  // Look for meta row { type: "__meta__", taxable: boolean }
  let taxable = true;
  if (arr.length && arr[0] && arr[0].type === '__meta__') {
    const meta = arr[0];
    taxable = typeof meta.taxable === 'boolean' ? meta.taxable
             : (typeof meta.taxable === 'string' ? meta.taxable.toLowerCase() === 'true' : true);
    arr = arr.slice(1); // strip meta from the actual list
  }
  return { variations: arr, taxable };
}

function buildVariationsToStore(variations, taxable) {
  const safe = Array.isArray(variations) ? variations : [];
  // Prepend meta row so we don't need a new column
  const meta = { type: '__meta__', taxable: !!taxable };
  return [meta, ...safe];
}

/**
 * GET /api/custom_tabs
 * Return tabs with `taxable` flattened out and meta removed from `variations`.
 */
router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT id, user_id, name, description, variations
         FROM custom_tabs
        WHERE user_id = $1
        ORDER BY id ASC`,
      [userId]
    );

    const rows = result.rows.map(row => {
      const { variations, taxable } = parseVariations(row.variations);
      return {
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        description: row.description,
        taxable,
        variations, // meta removed
      };
    });

    res.json(rows);
  } catch (error) {
    console.error('GET custom_tabs failed:', error);
    res.status(500).json({ error: 'Failed to fetch custom tabs' });
  }
});

/**
 * POST /api/custom_tabs
 * Create a new custom tab; store `taxable` inside variations meta row.
 */
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { name, description = '', variations = [], taxable = true } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Tab name is required' });
  }

  try {
    const stored = buildVariationsToStore(variations, !!taxable);

    const result = await pool.query(
      `INSERT INTO custom_tabs (user_id, name, description, variations)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, name, description, variations`,
      [userId, name.trim(), description, JSON.stringify(stored)]
    );

    const row = result.rows[0];
    const parsed = parseVariations(row.variations);

    res.status(201).json({
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      description: row.description,
      taxable: parsed.taxable,
      variations: parsed.variations,
    });
  } catch (error) {
    console.error('POST custom_tabs failed:', error);
    res.status(500).json({ error: 'Failed to create custom tab' });
  }
});

/**
 * PUT /api/custom_tabs/:id
 * Update name/description/variations and optionally taxable (still stored in meta).
 */
router.put('/:id', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const { variations, name, description, taxable } = req.body || {};

  try {
    // Load existing to preserve meta (taxable) if not passed
    const current = await pool.query(
      `SELECT variations FROM custom_tabs WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (current.rowCount === 0) {
      return res.status(404).json({ error: 'Tab not found or does not belong to user' });
    }

    const currParsed = parseVariations(current.rows[0].variations);
    const nextTaxable = (typeof taxable === 'boolean' || typeof taxable === 'string')
      ? (typeof taxable === 'boolean' ? taxable : taxable.toLowerCase() === 'true')
      : currParsed.taxable;

    const toStore = buildVariationsToStore(
      Array.isArray(variations) ? variations : currParsed.variations,
      nextTaxable
    );

    const result = await pool.query(
      `UPDATE custom_tabs
          SET variations = $1,
              name = COALESCE($2, name),
              description = COALESCE($3, description)
        WHERE id = $4 AND user_id = $5
        RETURNING id, user_id, name, description, variations`,
      [JSON.stringify(toStore), name ? name.trim() : null, description, id, userId]
    );

    const row = result.rows[0];
    const parsed = parseVariations(row.variations);

    res.json({
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      description: row.description,
      taxable: parsed.taxable,
      variations: parsed.variations,
    });
  } catch (error) {
    console.error('PUT custom_tabs failed:', error);
    res.status(500).json({ error: 'Failed to update custom tab' });
  }
});

/**
 * DELETE /api/custom_tabs/:id
 */
router.delete('/:id', async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM custom_tabs
        WHERE id = $1 AND user_id = $2
        RETURNING id, name`,
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tab not found or does not belong to user' });
    }

    res.json({ message: 'Custom tab deleted', deletedTab: result.rows[0] });
  } catch (error) {
    console.error('DELETE custom_tabs failed:', error);
    res.status(500).json({ error: 'Failed to delete custom tab' });
  }
});

module.exports = router;
