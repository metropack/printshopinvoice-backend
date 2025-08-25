// backend local/middleware/authenticate.js

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // e.g. { id, email }
    next();
  } catch (err) {
    
    return res.status(403).json({ error: 'Invalid token' });
  }
}

module.exports = authenticate;
