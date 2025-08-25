const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticate = require('../middleware/authenticate');

router.use(authenticate);

// GET /api/customers
router.get('/', async (req, res) => {
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
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/customers/upsert
router.post('/upsert', async (req, res) => {
  const {
    name = 'Unnamed',
    company = '',
    email = '',
    phone = '',
    address = ''
  } = req.body;

  const userId = req.user.id;

  if (!name?.trim() && !company?.trim()) {

    return res.status(400).json({ error: 'At least a name or company is required' });
  }

  try {
    // Check if customer exists for this user
    const result = await pool.query(
      `SELECT id FROM customers 
       WHERE 
         user_id = $3
         AND COALESCE(name, '') = $1 
         AND COALESCE(company, '') = $2
       LIMIT 1`,
      [name.trim(), company.trim(), userId]
    );

    if (result.rows.length > 0) {
      const customerId = result.rows[0].id;
      await pool.query(
        `UPDATE customers SET
          email = $1,
          phone = $2,
          address = $3
         WHERE id = $4
           AND user_id = $5`,
        [email, phone, address, customerId, userId]
      );
      return res.json({ customerId });
    }

    const insert = await pool.query(
      `INSERT INTO customers (user_id, name, company, email, phone, address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, name.trim(), company.trim(), email, phone, address]
    );
    res.json({ customerId: insert.rows[0].id });

  } catch (err) {
    
    res.status(500).json({ error: 'Failed to upsert customer', details: err.message });
  }
});

// PUT /api/customers/:id
router.put('/:id', async (req, res) => {
  const customerId = parseInt(req.params.id);
  const { name, company, email, phone, address } = req.body;
  const userId = req.user.id;

  if (!customerId || isNaN(customerId)) {
    return res.status(400).json({ error: 'Invalid customer ID' });
  }

  try {
    const result = await pool.query(
      `UPDATE customers
       SET name = $1, company = $2, email = $3, phone = $4, address = $5
       WHERE id = $6 AND user_id = $7
       RETURNING id`,
      [name || '', company || '', email || '', phone || '', address || '', customerId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ customerId: result.rows[0].id });
  } catch (err) {
   
    res.status(500).json({ error: 'Failed to update customer', details: err.message });
  }
});




module.exports = router;
