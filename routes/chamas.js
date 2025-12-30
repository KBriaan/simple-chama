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
  getChamaStats,
  checkPaymentStatus,
  getPaymentHistory,
  getMyPayments,
  mpesaCallback
} = require('../controllers/chamaController');

router.use(protect);

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

router.get('/:id/stats', protect, getChamaStats);
router.get('/:id/payments/:paymentId/status', protect, checkPaymentStatus);
router.get('/:id/payments/history', protect, getPaymentHistory);
router.get('/:id/my-payments', protect, getMyPayments);
router.post('/payments/mpesa-callback', mpesaCallback);
module.exports = router;