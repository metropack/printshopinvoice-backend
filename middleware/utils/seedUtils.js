// backend/utils/seedUtils.js
// backend/middleware/utils/seedUtils.js
const pool = require('../../db');


/**
 * Copy all default variations (user_id is NULL) into
 * a new user’s private variations
 *
 * @param {number} userId
 */
async function copyDefaultVariationsToUser(userId) {
  try {
    await pool.query(`
      INSERT INTO product_variations
        (product_id, user_id, size, price, accessory, quantity)
      SELECT
        product_id,
        $1,
        size,
        price,
        accessory,
        quantity
      FROM product_variations
      WHERE user_id IS NULL
    `, [userId]);

    
  } catch (err) {
 
    throw err;
  }
}

module.exports = {
  copyDefaultVariationsToUser
};
