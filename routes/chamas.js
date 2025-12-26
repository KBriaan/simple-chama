const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  createChama,
  getMyChamas,
  getChama,
  updateChama,
  addMember,
  removeMember,
  getChamaStats,initiateMpesaPayment,
  checkPaymentStatus,
  getPaymentHistory,
  getMyPayments,
  mpesaCallback
} = require('../controllers/chamaController');

// All routes are protected
router.use(protect);

// Chama routes
router.route('/')
  .post(createChama)
  .get(getMyChamas);

router.route('/:id')
  .get(getChama)
  .put(updateChama);

router.route('/:id/members')
  .post(addMember);

router.route('/:id/members/:memberId')
  .delete(removeMember);

router.get('/:id/stats', getChamaStats);
// M-Pesa payment routes
router.post('/:id/payments/mpesa', protect, initiateMpesaPayment);
router.get('/:id/payments/:paymentId/status', protect, checkPaymentStatus);
router.get('/:id/payments/history', protect, getPaymentHistory);
router.get('/:id/my-payments', protect, getMyPayments);

// M-Pesa callback (public endpoint - called by Safaricom)
router.post('/payments/mpesa-callback', mpesaCallback);

// Existing routes
module.exports = router;