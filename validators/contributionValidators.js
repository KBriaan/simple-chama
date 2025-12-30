// validators/contributionValidators.js
const { check, body } = require('express-validator');

// Contribution Type Validators
exports.validateContributionType = [
  check('chamaId')
    .isInt()
    .withMessage('Valid chama ID is required'),
  
  check('name')
    .notEmpty()
    .withMessage('Type name is required')
    .isLength({ max: 100 })
    .withMessage('Type name must be less than 100 characters'),
  
  check('description')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Description must be less than 500 characters'),
  
  check('defaultAmount')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Default amount must be a positive number'),
  
  check('frequency')
    .optional()
    .isIn(['weekly', 'monthly', 'quarterly', 'yearly', 'custom'])
    .withMessage('Invalid frequency value'),
  
  check('isRequired')
    .optional()
    .isBoolean()
    .withMessage('isRequired must be true or false'),
  
  check('isActive')
    .optional()
    .isBoolean()
    .withMessage('isActive must be true or false')
];

// Contribution Cycle Validators
exports.validateContributionCycle = [
  check('chamaId')
    .isInt()
    .withMessage('Valid chama ID is required'),
  
  check('cycleName')
    .optional()
    .isLength({ max: 100 })
    .withMessage('Cycle name must be less than 100 characters'),
  
  check('cycleDate')
    .isDate()
    .withMessage('Valid cycle date is required'),
  
  check('dueDate')
    .isDate()
    .withMessage('Valid due date is required')
    .custom((value, { req }) => {
      if (new Date(value) < new Date(req.body.cycleDate)) {
        throw new Error('Due date must be after cycle date');
      }
      return true;
    }),
  
  check('status')
    .optional()
    .isIn(['active', 'upcoming', 'completed', 'cancelled'])
    .withMessage('Invalid status value'),
  
  check('cycleId')
    .optional()
    .isInt()
    .withMessage('Valid cycle ID is required'),
  
  check('types')
    .optional()
    .isArray()
    .withMessage('Types must be an array'),
  
  body('types.*.typeId')
    .if(body('types').exists())
    .isInt()
    .withMessage('Valid type ID is required'),
  
  body('types.*.amount')
    .if(body('types').exists())
    .isFloat({ min: 0 })
    .withMessage('Amount must be a positive number')
];

// Contribution Validators
exports.validateContribution = [
  check('chamaId')
    .isInt()
    .withMessage('Valid chama ID is required'),
  
  check('memberId')
    .isInt()
    .withMessage('Valid member ID is required'),
  
  check('cycleId')
    .optional()
    .isInt()
    .withMessage('Valid cycle ID is required'),
  
  check('typeId')
    .optional()
    .isInt()
    .withMessage('Valid type ID is required'),
  
  check('amount')
    .isFloat({ min: 0 })
    .withMessage('Valid amount is required'),
  
  check('paymentMethod')
    .optional()
    .isIn(['cash', 'mpesa', 'bank_transfer', 'cheque', 'other', 'balance', 'rollover'])
    .withMessage('Invalid payment method'),
  
  check('paymentReference')
    .optional()
    .isLength({ max: 100 })
    .withMessage('Payment reference must be less than 100 characters'),
  
  check('notes')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Notes must be less than 500 characters'),
  
  check('applyToBalance')
    .optional()
    .isBoolean()
    .withMessage('applyToBalance must be true or false')
];

// Contribution Update Validators
exports.validateContributionUpdate = [
  check('amount')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Amount must be a positive number'),
  
  check('paymentMethod')
    .optional()
    .isIn(['cash', 'mpesa', 'bank_transfer', 'cheque', 'other', 'balance', 'rollover'])
    .withMessage('Invalid payment method'),
  
  check('paymentReference')
    .optional()
    .isLength({ max: 100 })
    .withMessage('Payment reference must be less than 100 characters'),
  
  check('notes')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Notes must be less than 500 characters'),
  
  check('status')
    .optional()
    .isIn(['pending', 'paid', 'late', 'partial', 'waived', 'cancelled'])
    .withMessage('Invalid status value')
];

// Balance Adjustment Validators
exports.validateBalanceAdjustment = [
  check('memberId')
    .isInt()
    .withMessage('Valid member ID is required'),
  
  check('amount')
    .isFloat()
    .withMessage('Valid amount is required'),
  
  check('reason')
    .notEmpty()
    .withMessage('Reason for adjustment is required')
    .isLength({ max: 500 })
    .withMessage('Reason must be less than 500 characters')
];

// Bulk Contributions Validators
exports.validateBulkContributions = [
  check('chamaId')
    .isInt()
    .withMessage('Valid chama ID is required'),
  
  check('contributions')
    .isArray({ min: 1 })
    .withMessage('Contributions array is required with at least one item'),
  
  body('contributions.*.memberId')
    .isInt()
    .withMessage('Valid member ID is required'),
  
  body('contributions.*.amount')
    .isFloat({ min: 0 })
    .withMessage('Valid amount is required'),
  
  body('contributions.*.paymentMethod')
    .optional()
    .isIn(['cash', 'mpesa', 'bank_transfer', 'cheque', 'other'])
    .withMessage('Invalid payment method'),
  
  body('contributions.*.paymentReference')
    .optional()
    .isLength({ max: 100 })
    .withMessage('Payment reference must be less than 100 characters'),
  
  body('contributions.*.notes')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Notes must be less than 500 characters'),
  
  check('notes')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Notes must be less than 500 characters')
];