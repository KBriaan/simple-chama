const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  recordContribution,
  getChamaContributions,
  getMemberContributions,
  updateContributionStatus,
  createContributionCycle
} = require('../controllers/contributionController');

// All routes are protected
router.use(protect);

// Contribution routes
router.post('/', recordContribution);
router.get('/chama/:chamaId', getChamaContributions);
router.get('/member/:memberId', getMemberContributions);
router.put('/:id/status', updateContributionStatus);
router.post('/cycles', createContributionCycle);

module.exports = router;