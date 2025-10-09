// backend/utils/ensureLineOverrideColumns.js
const pool = require('../db');

let _ran = false;

async function ensureLineOverrideColumns() {
  if (_ran) return;
  _ran = true;
  try {
    await pool.query(`
      ALTER TABLE estimate_items
        ADD COLUMN IF NOT EXISTS unit_price  NUMERIC,
        ADD COLUMN IF NOT EXISTS taxable     BOOLEAN,
        ADD COLUMN IF NOT EXISTS display_name TEXT;
    `);
    await pool.query(`
      ALTER TABLE invoice_items
        ADD COLUMN IF NOT EXISTS display_name TEXT;
    `);
    console.log('✅ ensureLineOverrideColumns: columns present');
  } catch (err) {
    console.error('⚠️ ensureLineOverrideColumns failed (non-fatal):', err);
    // keep running; routes may still work if columns already exist
  }
}

module.exports = { ensureLineOverrideColumns };
