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
  getChamaStats
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

module.exports = router;