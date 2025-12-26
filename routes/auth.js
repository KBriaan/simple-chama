const express = require('express');
const router = express.Router();
const {
  register,
  login,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  changePassword,
  getMe,
  updateProfile,
  debugResetCodes,
  cleanupResetCodes
} = require('../controllers/authController');

// Middleware for protecting routes
const { protect } = require('../middleware/auth');

// Rate limiting for password reset (prevent abuse)
const rateLimit = require('express-rate-limit');

// Apply rate limiting to password reset endpoints
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1100, // 5 requests per window
  message: {
    success: false,
    message: 'Too many password reset attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Public routes
router.post('/register', register);
router.post('/login', login);
router.post('/forgot-password', resetLimiter, forgotPassword);
router.post('/verify-reset-code', resetLimiter, verifyResetCode);
router.post('/reset-password', resetLimiter, resetPassword);

// Protected routes (require authentication)
router.get('/me', protect, getMe);
router.put('/update', protect, updateProfile);
router.put('/change-password', protect, changePassword);

// Debug/Admin routes (development only)
if (process.env.NODE_ENV === 'development') {
  router.get('/debug-reset-codes', debugResetCodes);
  router.post('/cleanup-reset-codes', cleanupResetCodes);
}

module.exports = router;