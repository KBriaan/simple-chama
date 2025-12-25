const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getFinancialReport,
  getMemberStatement,
  getDashboardStats
} = require('../controllers/reportController');

// All routes are protected
router.use(protect);

router.get('/chama/:chamaId/financial', getFinancialReport);
router.get('/member/:memberId/statement', getMemberStatement);
router.get('/chama/:chamaId/dashboard', getDashboardStats);

module.exports = router;