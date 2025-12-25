console.log('🔍 auth middleware: Loading database...');
const db = require('../config/database');
console.log('🔍 auth middleware: db loaded, has execute?', typeof db.execute === 'function');

const jwt = require('jsonwebtoken');

const protect = async (req, res, next) => {
  console.log('🔒 Auth middleware called');
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];
      console.log('🔒 Token received');

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log('🔒 Token decoded, user ID:', decoded.id);

      // Get user from database
      console.log('🔍 Fetching user from database...');
      const [users] = await db.execute(
        'SELECT id, name, phone, email, created_at FROM users WHERE id = ?',
        [decoded.id]
      );

      if (users.length === 0) {
        console.log('❌ User not found');
        return res.status(401).json({
          success: false,
          message: 'User not found'
        });
      }

      req.user = users[0];
      console.log('✅ User authenticated:', req.user.id, req.user.name);
      next();
    } catch (error) {
      console.error('❌ Auth middleware error:', error.message);
      console.error('Error stack:', error.stack);
      return res.status(401).json({
        success: false,
        message: 'Not authorized'
      });
    }
  }

  if (!token) {
    console.log('❌ No token provided');
    return res.status(401).json({
      success: false,
      message: 'Not authorized, no token'
    });
  }
};

// Optional: Admin middleware
const isAdmin = async (req, res, next) => {
  try {
    const [members] = await db.execute(
      `SELECT m.role 
       FROM members m
       INNER JOIN chamas c ON m.chama_id = c.id
       WHERE m.user_id = ? AND m.chama_id = ? AND m.role = 'admin'`,
      [req.user.id, req.params.chamaId || req.body.chamaId]
    );

    if (members.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

module.exports = { protect, isAdmin };