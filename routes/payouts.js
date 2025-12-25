const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  createPayout,
  updatePayoutStatus,
  getChamaPayouts,
  getMemberPayouts,
  getNextPayoutMember
} = require('../controllers/payoutController');

// All routes are protected
router.use(protect);

router.post('/', createPayout);
router.put('/:id/status', updatePayoutStatus);
router.get('/chama/:chamaId', getChamaPayouts);
router.get('/member/:memberId', getMemberPayouts);
router.get('/next/:chamaId', getNextPayoutMember);

module.exports = router;