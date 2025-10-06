// backend/routes/storeInfoRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ---------- Constants ----------
const DEFAULT_DISCLAIMER =
  'By signing below, the customer agrees to the charges listed. Monitor calibration, file format, and production methods may cause slight differences.';

// ---------- Auth ----------
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
    req.userId = decoded.id || decoded.userId || decoded.sub;
    if (!req.userId) return res.status(401).json({ error: 'Invalid token: userId not found' });
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// ---------- Helpers ----------
const sanitizeTaxRate = (tax_rate) => {
  let rate = Number(tax_rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) rate = 0.06;
  return rate;
};

const sanitizeDisclaimer = (value) => {
  let s = (value == null ? '' : String(value)).trim();
  if (!s) s = DEFAULT_DISCLAIMER;
  if (s.length > 1000) s = s.slice(0, 1000); // hard cap at 1000 chars
  return s;
};

const logosDir = path.join(__dirname, '..', 'uploads', 'logos');
const ensureLogosDir = () => {
  try { fs.mkdirSync(logosDir, { recursive: true }); } catch {}
};

const removeIfExists = (filepath) => {
  try {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch {}
};

// Remove any existing logo for a user regardless of extension
const removeUserLogos = (userId) => {
  removeIfExists(path.join(logosDir, `${userId}.png`));
  removeIfExists(path.join(logosDir, `${userId}.jpg`));
  removeIfExists(path.join(logosDir, `${userId}.jpeg`));
};

// ---------- Multer (disk) ----------
ensureLogosDir();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, logosDir);
  },
  filename: (req, file, cb) => {
    const userId = req.userId;
    const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
    // clean previous file(s) so we don’t leave stale extensions
    removeUserLogos(userId);
    cb(null, `${userId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') return cb(null, true);
    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'PNG or JPEG only'));
  },
});

// ---------- Upload logo ----------
router.post('/logo', authenticateToken, (req, res) => {
  upload.single('logo')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File exceeds 8MB' });
        return res.status(400).json({ error: err.message || 'Upload error' });
      }
      return res.status(400).json({ error: err?.message || 'Upload failed' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const userId = req.userId;
      const ext = path.extname(req.file.filename).toLowerCase();
      const publicUrl = `/uploads/logos/${userId}${ext}`; // served by express.static

      const result = await pool.query(
        `INSERT INTO store_info (user_id, logo_url)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET logo_url = EXCLUDED.logo_url
         RETURNING name, address, phone, email, logo_url, tax_rate, disclaimer`,
        [userId, publicUrl]
      );

      const row = result.rows[0] || {};
      const out = {
        ...row,
        tax_rate: sanitizeTaxRate(row.tax_rate),
        disclaimer: sanitizeDisclaimer(row.disclaimer),
      };
      return res.json(out);
    } catch (e) {
      console.error('Logo save failed:', e);
      return res.status(500).json({ error: 'Failed to save logo' });
    }
  });
});

// ---------- Delete logo ----------
router.delete('/logo', authenticateToken, async (req, res) => {
  const userId = req.userId;
  try {
    // Remove files on disk
    removeUserLogos(userId);

    // Clear path in DB
    const result = await pool.query(
      `UPDATE store_info SET logo_url = '' WHERE user_id = $1
       RETURNING name, address, phone, email, logo_url, tax_rate, disclaimer`,
      [userId]
    );

    const row = result.rows[0] || { name: '', address: '', phone: '', email: '', logo_url: '', tax_rate: 0.06, disclaimer: DEFAULT_DISCLAIMER };
    const out = {
      ...row,
      tax_rate: sanitizeTaxRate(row.tax_rate),
      disclaimer: sanitizeDisclaimer(row.disclaimer),
    };
    return res.json(out);
  } catch (e) {
    console.error('Logo delete failed:', e);
    return res.status(500).json({ error: 'Failed to delete logo' });
  }
});

// ---------- Upsert store info (text fields only) ----------
router.post('/', authenticateToken, async (req, res) => {
  const { name, address, phone, email, tax_rate, disclaimer } = req.body || {};
  const userId = req.userId;
  const rate = sanitizeTaxRate(tax_rate);
  const safeDisclaimer = sanitizeDisclaimer(disclaimer);

  try {
    const result = await pool.query(
      `INSERT INTO store_info (user_id, name, address, phone, email, tax_rate, disclaimer)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         address = EXCLUDED.address,
         phone = EXCLUDED.phone,
         email = EXCLUDED.email,
         tax_rate = EXCLUDED.tax_rate,
         disclaimer = EXCLUDED.disclaimer
       RETURNING name, address, phone, email, logo_url, tax_rate, disclaimer`,
      [userId, name || '', address || '', phone || '', email || '', rate, safeDisclaimer]
    );

    const row = result.rows[0] || {};
    const out = {
      ...row,
      tax_rate: sanitizeTaxRate(row.tax_rate),
      disclaimer: sanitizeDisclaimer(row.disclaimer),
    };
    return res.status(200).json(out);
  } catch (error) {
    console.error('Error saving store info:', error);
    return res.status(500).json({ error: 'Failed to save store info' });
  }
});

// ---------- Get store info ----------
router.get('/', authenticateToken, async (req, res) => {
  const userId = req.userId;

  try {
    const result = await pool.query(
      `SELECT name, address, phone, email, logo_url, tax_rate, disclaimer
       FROM store_info WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({
        name: '',
        address: '',
        phone: '',
        email: '',
        logo_url: '',
        tax_rate: 0.06,
        disclaimer: DEFAULT_DISCLAIMER,
      });
    }

    const row = result.rows[0];
    const out = {
      ...row,
      tax_rate: sanitizeTaxRate(row.tax_rate),
      disclaimer: sanitizeDisclaimer(row.disclaimer),
    };
    return res.status(200).json(out);
  } catch (error) {
    console.error('Error fetching store info:', error);
    return res.status(500).json({ error: 'Failed to fetch store info' });
  }
});

module.exports = router;
