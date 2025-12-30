// routes/contributionRoutes.js
const express = require('express');
const router = express.Router();
const {
  // Contribution Types
  createContributionType,
  updateContributionType,
  deleteContributionType,
  getContributionTypes,
  getContributionTypeById,
  
  // Contribution Cycles
  createOrUpdateCycle,
  getChamaCycles,
  getCycleDetails,
  updateCycleStatus,
  deleteCycle,
  
  // Contributions
  recordContribution,
  updateContribution,
  deleteContribution,
  getContributionById,
  getChamaContributions,
  getMemberContributions,
  updateContributionStatus,
  
  // Member Status & Reports
  getMemberContributionStatus,
  getContributionSummary,
  getContributionReport,
  
  // Balance Management
  adjustMemberBalance,
  getMemberBalanceHistory,
  
  // Scheduled & Bulk Operations
  processScheduledContributions,
  recordBulkContributions,
  
  // Dashboard & Analytics
  getContributionDashboard,
  getContributionAnalytics
} = require('../controllers/contributionController');

const { protect } = require('../middleware/auth');
const { validateRequest } = require('../middleware/validationMiddleware');

// Import validators
const {
  validateContributionType,
  validateContributionCycle,
  validateContribution,
  validateContributionUpdate,
  validateBalanceAdjustment,
  validateBulkContributions
} = require('../validators/contributionValidators');

// ============================================
// MIDDLEWARE - Apply authentication to all routes
// ============================================
router.use(protect);

// ============================================
// CONTRIBUTION TYPES ROUTES
// ============================================

/**
 * @route   POST /api/contributions/types
 * @desc    Create a new contribution type
 * @access  Private (Admin only)
 * @body    {chamaId, name, description, defaultAmount, frequency, isRequired}
 */
router.post(
  '/types',
  validateContributionType,
  validateRequest,
  createContributionType
);

/**
 * @route   PUT /api/contributions/types/:typeId
 * @desc    Update a contribution type
 * @access  Private (Admin only)
 * @body    {name, description, defaultAmount, frequency, isRequired, isActive}
 */
router.put(
  '/types/:typeId',
  validateContributionType,
  validateRequest,
  updateContributionType
);

/**
 * @route   DELETE /api/contributions/types/:typeId
 * @desc    Delete a contribution type
 * @access  Private (Admin only)
 */
router.delete('/types/:typeId', deleteContributionType);

/**
 * @route   GET /api/contributions/types/chama/:chamaId
 * @desc    Get all contribution types for a chama
 * @access  Private (Members)
 * @query   {isActive} - Filter by active status (true/false)
 */
router.get('/types/chama/:chamaId', getContributionTypes);

/**
 * @route   GET /api/contributions/types/:typeId
 * @desc    Get a specific contribution type
 * @access  Private (Members)
 */
router.get('/types/:typeId', getContributionTypeById);

// ============================================
// CONTRIBUTION CYCLES ROUTES
// ============================================

/**
 * @route   POST /api/contributions/cycles
 * @desc    Create or update a contribution cycle
 * @access  Private (Admin only)
 * @body    {chamaId, cycleName, cycleDate, dueDate, notes, status, cycleId, types[]}
 */
router.post(
  '/cycles',
  validateContributionCycle,
  validateRequest,
  createOrUpdateCycle
);

/**
 * @route   GET /api/contributions/cycles/chama/:chamaId
 * @desc    Get all cycles for a chama
 * @access  Private (Members)
 * @query   {status, page, limit} - Filter and pagination
 */
router.get('/cycles/chama/:chamaId', getChamaCycles);

/**
 * @route   GET /api/contributions/cycles/:cycleId
 * @desc    Get detailed information about a specific cycle
 * @access  Private (Members)
 */
router.get('/cycles/:cycleId', getCycleDetails);

/**
 * @route   PUT /api/contributions/cycles/:cycleId/status
 * @desc    Update the status of a contribution cycle
 * @access  Private (Admin only)
 * @body    {status} - new status (active/upcoming/completed/cancelled)
 */
router.put('/cycles/:cycleId/status', updateCycleStatus);

/**
 * @route   DELETE /api/contributions/cycles/:cycleId
 * @desc    Delete a contribution cycle
 * @access  Private (Admin only)
 */
router.delete('/cycles/:cycleId', deleteCycle);

// ============================================
// CONTRIBUTIONS ROUTES
// ============================================

/**
 * @route   POST /api/contributions
 * @desc    Record a new contribution
 * @access  Private (Self or Admin)
 * @body    {chamaId, memberId, cycleId, typeId, amount, paymentMethod, paymentReference, notes, applyToBalance}
 */
router.post(
  '/',
  validateContribution,
  validateRequest,
  recordContribution
);

/**
 * @route   PUT /api/contributions/:contributionId
 * @desc    Update a contribution (admin only)
 * @access  Private (Admin only)
 * @body    {amount, paymentMethod, paymentReference, notes, status}
 */
router.put(
  '/:contributionId',
  validateContributionUpdate,
  validateRequest,
  updateContribution
);

/**
 * @route   DELETE /api/contributions/:contributionId
 * @desc    Delete a contribution (admin only)
 * @access  Private (Admin only)
 */
router.delete('/:contributionId', deleteContribution);

/**
 * @route   GET /api/contributions/:contributionId
 * @desc    Get details of a specific contribution
 * @access  Private (Members)
 */
router.get('/:contributionId', getContributionById);

/**
 * @route   GET /api/contributions/chama/:chamaId
 * @desc    Get all contributions for a chama
 * @access  Private (Members)
 * @query   {cycleId, memberId, status, startDate, endDate, page, limit}
 */
router.get('/chama/:chamaId', getChamaContributions);

/**
 * @route   GET /api/contributions/member/:memberId
 * @desc    Get all contributions for a specific member
 * @access  Private (Self or Admin)
 * @query   {cycleId, status, startDate, endDate, page, limit}
 */
router.get('/member/:memberId', getMemberContributions);

/**
 * @route   PUT /api/contributions/:contributionId/status
 * @desc    Update contribution status (legacy endpoint)
 * @access  Private (Admin only)
 * @body    {status} - new status (pending/paid/late/partial/waived/cancelled)
 */
router.put('/:contributionId/status', updateContributionStatus);

// ============================================
// MEMBER STATUS & REPORTS ROUTES
// ============================================

/**
 * @route   GET /api/contributions/member/:memberId/status
 * @desc    Get detailed contribution status for a member
 * @access  Private (Self or Admin)
 */
router.get('/member/:memberId/status', getMemberContributionStatus);

/**
 * @route   GET /api/contributions/summary/:chamaId/:memberId?
 * @desc    Get contribution summary for chama or specific member
 * @access  Private (Self or Admin)
 * @query   {startDate, endDate, cycleId}
 */
router.get('/summary/:chamaId/:memberId?', getContributionSummary);

/**
 * @route   GET /api/contributions/report/:chamaId
 * @desc    Get detailed contribution report for chama (admin only)
 * @access  Private (Admin only)
 * @query   {startDate, endDate, cycleId, status}
 */
router.get('/report/:chamaId', getContributionReport);

// ============================================
// BALANCE MANAGEMENT ROUTES
// ============================================

/**
 * @route   POST /api/contributions/balance/adjust
 * @desc    Adjust member balance (admin only)
 * @access  Private (Admin only)
 * @body    {memberId, amount, reason}
 */
router.post(
  '/balance/adjust',
  validateBalanceAdjustment,
  validateRequest,
  adjustMemberBalance
);

/**
 * @route   GET /api/contributions/balance/history/:memberId
 * @desc    Get balance history for a member
 * @access  Private (Self or Admin)
 * @query   {startDate, endDate, page, limit}
 */
router.get('/balance/history/:memberId', getMemberBalanceHistory);

// ============================================
// SCHEDULED & BULK OPERATIONS ROUTES
// ============================================

/**
 * @route   POST /api/contributions/process-scheduled
 * @desc    Process scheduled/automatic contributions
 * @access  Private (Admin only)
 * @body    {chamaId}
 */
router.post('/process-scheduled', processScheduledContributions);

/**
 * @route   POST /api/contributions/bulk
 * @desc    Record multiple contributions in bulk
 * @access  Private (Admin only)
 * @body    {chamaId, contributions[], notes}
 */
router.post(
  '/bulk',
  validateBulkContributions,
  validateRequest,
  recordBulkContributions
);

// ============================================
// DASHBOARD & ANALYTICS ROUTES
// ============================================

/**
 * @route   GET /api/contributions/dashboard/:chamaId
 * @desc    Get contribution dashboard for chama
 * @access  Private (Members)
 * @query   {period} - Time period for dashboard data
 */
router.get('/dashboard/:chamaId', getContributionDashboard);

/**
 * @route   GET /api/contributions/analytics/:chamaId
 * @desc    Get detailed contribution analytics (admin only)
 * @access  Private (Admin only)
 * @query   {period, startDate, endDate}
 */
router.get('/analytics/:chamaId', getContributionAnalytics);

// ============================================
// EXPORT ROUTER
// ============================================
module.exports = router;