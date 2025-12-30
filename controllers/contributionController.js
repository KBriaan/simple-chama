// controllers/contributionController.js
const db = require('../config/database');

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Update member balance and record in ledger
 */
const updateMemberBalance = async (memberId, amount, description, userId, cycleId = null, contributionId = null) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();

    // Get current balance
    const [balanceRows] = await connection.execute(
      `SELECT contribution_balance FROM members WHERE id = ?`,
      [memberId]
    );
    
    const currentBalance = balanceRows[0]?.contribution_balance || 0;
    const newBalance = currentBalance + amount;

    // Update member balance
    await connection.execute(
      `UPDATE members SET contribution_balance = ? WHERE id = ?`,
      [newBalance, memberId]
    );

    // Record in ledger if table exists
    try {
      await connection.execute(
        `INSERT INTO contribution_ledger 
         (member_id, cycle_id, contribution_id, transaction_type, 
          amount, balance_before, balance_after, description, created_by) 
         VALUES (?, ?, ?, 'contribution', ?, ?, ?, ?, ?)`,
        [
          memberId,
          cycleId,
          contributionId,
          amount,
          currentBalance,
          newBalance,
          description,
          userId
        ]
      );
    } catch (ledgerError) {
      console.log('Ledger table might not exist, continuing without ledger entry');
    }

    await connection.commit();
    return newBalance;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

/**
 * Handle type-specific contribution creation/update
 */
const handleTypeContribution = async (
  memberId, cycleId, typeId, amount, expectedAmount,
  paymentMethod, paymentReference, recordedById, existingContributions
) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();

    let contributionId;
    let status = 'partial';
    
    // Determine status
    if (Math.abs(amount - expectedAmount) < 0.01) {
      status = 'paid';
    } else if (amount <= 0) {
      status = 'pending';
    }

    if (existingContributions && existingContributions.length > 0) {
      // Update existing contribution
      const existing = existingContributions[0];
      const newAmount = (parseFloat(existing.amount) || 0) + amount;
      const newStatus = Math.abs(newAmount - expectedAmount) < 0.01 ? 'paid' : 
                       newAmount > 0 ? 'partial' : 'pending';
      
      await connection.execute(
        `UPDATE contributions 
         SET amount = ?, status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [newAmount, newStatus, existing.id]
      );
      
      contributionId = existing.id;
    } else {
      // Create new contribution
      const [result] = await connection.execute(
        `INSERT INTO contributions 
         (member_id, cycle_id, type_id, amount, expected_amount,
          payment_method, payment_reference, payment_date,
          recorded_by, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
        [
          memberId,
          cycleId,
          typeId,
          amount,
          expectedAmount,
          paymentMethod || 'cash',
          paymentReference || null,
          recordedById,
          status
        ]
      );
      
      contributionId = result.insertId;
    }

    await connection.commit();
    
    return {
      id: contributionId,
      member_id: memberId,
      cycle_id: cycleId,
      type_id: typeId,
      amount: amount,
      expected_amount: expectedAmount,
      status: status
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

/**
 * Check if user has permission for member
 */
const checkMemberPermission = async (userId, memberId, requireAdmin = false) => {
  const [member] = await db.execute(
    `SELECT m.*, m.user_id as member_user_id 
     FROM members m
     WHERE m.id = ?`,
    [memberId]
  );

  if (member.length === 0) {
    return { authorized: false, message: 'Member not found' };
  }

  const isSelf = member[0].member_user_id === userId;

  if (requireAdmin) {
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [member[0].chama_id, userId]
    );
    
    const isAdmin = adminCheck.length > 0;
    return { 
      authorized: isAdmin, 
      isAdmin, 
      isSelf,
      member: member[0],
      message: isAdmin ? 'Authorized' : 'Not authorized as admin'
    };
  }

  // For non-admin requirements
  if (isSelf) {
    return { authorized: true, isAdmin: false, isSelf: true, member: member[0] };
  }

  // Check if user is admin of the chama
  const [adminCheck] = await db.execute(
    `SELECT role FROM members 
     WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
    [member[0].chama_id, userId]
  );
  
  const isAdmin = adminCheck.length > 0;
  return { 
    authorized: isAdmin || isSelf, 
    isAdmin, 
    isSelf,
    member: member[0],
    message: (isAdmin || isSelf) ? 'Authorized' : 'Not authorized'
  };
};

// ============================================
// CONTRIBUTION TYPES CONTROLLERS
// ============================================

/**
 * @desc    Create contribution type
 * @route   POST /api/contributions/types
 * @access  Private (Admin only)
 */
const createContributionType = async (req, res) => {
  const { chamaId, name, description, defaultAmount, frequency, isRequired } = req.body;

  try {
    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [chamaId, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Check if type with same name exists
    const [existing] = await db.execute(
      `SELECT id FROM contribution_types 
       WHERE chama_id = ? AND name = ?`,
      [chamaId, name]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Contribution type with this name already exists'
      });
    }

    const [result] = await db.execute(
      `INSERT INTO contribution_types 
       (chama_id, name, description, default_amount, frequency, is_required, is_active) 
       VALUES (?, ?, ?, ?, ?, ?, true)`,
      [
        chamaId,
        name,
        description || null,
        defaultAmount || 0,
        frequency || 'monthly',
        isRequired !== undefined ? isRequired : true
      ]
    );

    const [type] = await db.execute(
      'SELECT * FROM contribution_types WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'Contribution type created successfully',
      data: type[0]
    });
  } catch (error) {
    console.error('❌ Create contribution type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating contribution type'
    });
  }
};

/**
 * @desc    Update contribution type
 * @route   PUT /api/contributions/types/:typeId
 * @access  Private (Admin only)
 */
const updateContributionType = async (req, res) => {
  const { typeId } = req.params;
  const { name, description, defaultAmount, frequency, isRequired, isActive } = req.body;

  try {
    // Get type details to check chama
    const [type] = await db.execute(
      `SELECT chama_id FROM contribution_types WHERE id = ?`,
      [typeId]
    );

    if (type.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contribution type not found'
      });
    }

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [type[0].chama_id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Check if name is being changed and conflicts
    if (name) {
      const [existing] = await db.execute(
        `SELECT id FROM contribution_types 
         WHERE chama_id = ? AND name = ? AND id != ?`,
        [type[0].chama_id, name, typeId]
      );

      if (existing.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Another contribution type with this name already exists'
        });
      }
    }

    // Build update query
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }

    if (description !== undefined) {
      updates.push('description = ?');
      params.push(description);
    }

    if (defaultAmount !== undefined) {
      updates.push('default_amount = ?');
      params.push(defaultAmount);
    }

    if (frequency !== undefined) {
      updates.push('frequency = ?');
      params.push(frequency);
    }

    if (isRequired !== undefined) {
      updates.push('is_required = ?');
      params.push(isRequired);
    }

    if (isActive !== undefined) {
      updates.push('is_active = ?');
      params.push(isActive);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    params.push(typeId);

    await db.execute(
      `UPDATE contribution_types SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // Get updated type
    const [updatedType] = await db.execute(
      'SELECT * FROM contribution_types WHERE id = ?',
      [typeId]
    );

    res.json({
      success: true,
      message: 'Contribution type updated successfully',
      data: updatedType[0]
    });
  } catch (error) {
    console.error('❌ Update contribution type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating contribution type'
    });
  }
};

/**
 * @desc    Delete contribution type
 * @route   DELETE /api/contributions/types/:typeId
 * @access  Private (Admin only)
 */
const deleteContributionType = async (req, res) => {
  const { typeId } = req.params;

  try {
    // Get type details to check chama
    const [type] = await db.execute(
      `SELECT chama_id FROM contribution_types WHERE id = ?`,
      [typeId]
    );

    if (type.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contribution type not found'
      });
    }

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [type[0].chama_id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Check if type is used in any cycles
    const [usedInCycles] = await db.execute(
      `SELECT COUNT(*) as count FROM cycle_types WHERE type_id = ?`,
      [typeId]
    );

    if (usedInCycles[0].count > 0) {
      // Soft delete by deactivating
      await db.execute(
        'UPDATE contribution_types SET is_active = false WHERE id = ?',
        [typeId]
      );
      
      res.json({
        success: true,
        message: 'Contribution type deactivated (used in existing cycles)'
      });
    } else {
      // Hard delete
      await db.execute('DELETE FROM contribution_types WHERE id = ?', [typeId]);
      
      res.json({
        success: true,
        message: 'Contribution type deleted successfully'
      });
    }
  } catch (error) {
    console.error('❌ Delete contribution type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting contribution type'
    });
  }
};

/**
 * @desc    Get contribution types for chama
 * @route   GET /api/contributions/types/chama/:chamaId
 * @access  Private (Members)
 */
const getContributionTypes = async (req, res) => {
  try {
    const { chamaId } = req.params;
    const { isActive } = req.query;

    // Check membership
    const [membership] = await db.execute(
      'SELECT id FROM members WHERE chama_id = ? AND user_id = ?',
      [chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    let query = 'SELECT * FROM contribution_types WHERE chama_id = ?';
    const params = [chamaId];

    if (isActive !== undefined) {
      query += ' AND is_active = ?';
      params.push(isActive === 'true');
    }

    query += ' ORDER BY created_at DESC';

    const [types] = await db.execute(query, params);

    res.json({
      success: true,
      count: types.length,
      data: types
    });
  } catch (error) {
    console.error('❌ Get contribution types error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching contribution types'
    });
  }
};

/**
 * @desc    Get contribution type by ID
 * @route   GET /api/contributions/types/:typeId
 * @access  Private (Members)
 */
const getContributionTypeById = async (req, res) => {
  try {
    const { typeId } = req.params;

    const [type] = await db.execute(
      `SELECT ct.* FROM contribution_types ct
       JOIN members m ON ct.chama_id = m.chama_id
       WHERE ct.id = ? AND m.user_id = ?`,
      [typeId, req.user.id]
    );

    if (type.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contribution type not found or not authorized'
      });
    }

    res.json({
      success: true,
      data: type[0]
    });
  } catch (error) {
    console.error('❌ Get contribution type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching contribution type'
    });
  }
};

// ============================================
// CONTRIBUTION CYCLES CONTROLLERS
// ============================================

/**
 * @desc    Create or update contribution cycle
 * @route   POST /api/contributions/cycles
 * @access  Private (Admin only)
 */
const createOrUpdateCycle = async (req, res) => {
  const { 
    chamaId, 
    cycleName, 
    cycleDate, 
    dueDate, 
    notes,
    status = 'upcoming',
    cycleId,  // For updates
    types  // Array of { typeId, amount }
  } = req.body;

  try {
    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [chamaId, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    let cycleIdResult;
    
    if (cycleId) {
      // Update existing cycle
      await db.execute(
        `UPDATE contribution_cycles 
         SET cycle_name = ?, cycle_date = ?, due_date = ?, notes = ?, status = ?
         WHERE id = ? AND chama_id = ?`,
        [cycleName, cycleDate, dueDate, notes, status, cycleId, chamaId]
      );
      cycleIdResult = cycleId;
    } else {
      // Create new cycle
      const [lastCycle] = await db.execute(
        `SELECT MAX(cycle_number) as last_cycle_number 
         FROM contribution_cycles 
         WHERE chama_id = ?`,
        [chamaId]
      );

      const nextCycleNumber = (lastCycle[0].last_cycle_number || 0) + 1;

      // If activating new cycle, close previous active cycle
      if (status === 'active') {
        await db.execute(
          `UPDATE contribution_cycles 
           SET status = 'completed' 
           WHERE chama_id = ? AND status = 'active'`,
          [chamaId]
        );
      }

      const [result] = await db.execute(
        `INSERT INTO contribution_cycles 
         (chama_id, cycle_number, cycle_name, cycle_date, due_date, status, notes) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          chamaId,
          nextCycleNumber,
          cycleName || `Cycle ${nextCycleNumber}`,
          cycleDate,
          dueDate,
          status,
          notes || null
        ]
      );

      cycleIdResult = result.insertId;
    }

    // Handle cycle types if provided
    if (types && Array.isArray(types)) {
      // Remove existing types
      await db.execute('DELETE FROM cycle_types WHERE cycle_id = ?', [cycleIdResult]);
      
      // Add new types
      for (const type of types) {
        if (type.typeId && type.amount) {
          await db.execute(
            'INSERT INTO cycle_types (cycle_id, type_id, amount) VALUES (?, ?, ?)',
            [cycleIdResult, type.typeId, type.amount]
          );
        }
      }
    }

    // Get full cycle details
    const [cycles] = await db.execute(
      `SELECT cc.*, 
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'typeId', ct.id,
                  'typeName', ct.name,
                  'amount', ct2.amount
                )
              ) as cycle_types
       FROM contribution_cycles cc
       LEFT JOIN cycle_types ct2 ON cc.id = ct2.cycle_id
       LEFT JOIN contribution_types ct ON ct2.type_id = ct.id
       WHERE cc.id = ?
       GROUP BY cc.id`,
      [cycleIdResult]
    );

    res.json({
      success: true,
      message: cycleId ? 'Cycle updated successfully' : 'Cycle created successfully',
      data: cycles[0]
    });
  } catch (error) {
    console.error('❌ Create/update cycle error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error processing cycle'
    });
  }
};

/**
 * @desc    Get cycles for chama
 * @route   GET /api/contributions/cycles/chama/:chamaId
 * @access  Private (Members)
 */
const getChamaCycles = async (req, res) => {
  try {
    const { chamaId } = req.params;
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // Check membership
    const [membership] = await db.execute(
      'SELECT id FROM members WHERE chama_id = ? AND user_id = ?',
      [chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    let query = `
      SELECT cc.*, 
             COUNT(DISTINCT c.id) as contributions_count,
             COALESCE(SUM(c.amount), 0) as collected_amount,
             COUNT(DISTINCT m.id) as total_members,
             (SELECT COUNT(DISTINCT member_id) 
              FROM contributions 
              WHERE cycle_id = cc.id AND status = 'paid') as paid_members
      FROM contribution_cycles cc
      LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.status = 'paid'
      LEFT JOIN members m ON cc.chama_id = m.chama_id
      WHERE cc.chama_id = ?
    `;

    const params = [chamaId];

    if (status) {
      query += ' AND cc.status = ?';
      params.push(status);
    }

    query += ' GROUP BY cc.id ORDER BY cc.cycle_number DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [cycles] = await db.execute(query, params);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM contribution_cycles WHERE chama_id = ?';
    const countParams = [chamaId];

    if (status) {
      countQuery += ' AND status = ?';
      countParams.push(status);
    }

    const [totalCount] = await db.execute(countQuery, countParams);

    res.json({
      success: true,
      data: cycles,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount[0].total,
        pages: Math.ceil(totalCount[0].total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Get cycles error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching cycles'
    });
  }
};

/**
 * @desc    Get cycle details
 * @route   GET /api/contributions/cycles/:cycleId
 * @access  Private (Members)
 */
const getCycleDetails = async (req, res) => {
  try {
    const { cycleId } = req.params;

    // Get cycle
    const [cycles] = await db.execute(
      `SELECT cc.*, 
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'typeId', ct.id,
                  'typeName', ct.name,
                  'amount', ct2.amount
                )
              ) as cycle_types
       FROM contribution_cycles cc
       LEFT JOIN cycle_types ct2 ON cc.id = ct2.cycle_id
       LEFT JOIN contribution_types ct ON ct2.type_id = ct.id
       WHERE cc.id = ?
       GROUP BY cc.id`,
      [cycleId]
    );

    if (cycles.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cycle not found'
      });
    }

    const cycle = cycles[0];

    // Check membership
    const [membership] = await db.execute(
      'SELECT id FROM members WHERE chama_id = ? AND user_id = ?',
      [cycle.chama_id, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    // Get all members and their contributions for this cycle
    const [membersContributions] = await db.execute(
      `SELECT m.id as member_id, u.name, u.phone, m.role,
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'contributionId', c.id,
                  'typeId', c.type_id,
                  'typeName', ct.name,
                  'amount', c.amount,
                  'expectedAmount', c.expected_amount,
                  'status', c.status,
                  'paymentDate', c.payment_date,
                  'paymentMethod', c.payment_method
                )
              ) as contributions,
              CASE 
                WHEN EXISTS (
                  SELECT 1 FROM contributions 
                  WHERE member_id = m.id AND cycle_id = ? AND status = 'paid'
                ) THEN 'paid'
                WHEN cc.due_date < CURDATE() THEN 'overdue'
                ELSE 'pending'
              END as payment_status
       FROM members m
       JOIN users u ON m.user_id = u.id
       JOIN contribution_cycles cc ON m.chama_id = cc.chama_id
       LEFT JOIN contributions c ON m.id = c.member_id AND c.cycle_id = ?
       LEFT JOIN contribution_types ct ON c.type_id = ct.id
       WHERE m.chama_id = ? AND cc.id = ?
       GROUP BY m.id
       ORDER BY m.role DESC, u.name`,
      [cycleId, cycleId, cycle.chama_id, cycleId]
    );

    // Get summary
    const [summary] = await db.execute(
      `SELECT 
         COUNT(DISTINCT c.member_id) as paid_members,
         COUNT(DISTINCT m.id) as total_members,
         SUM(c.amount) as total_collected,
         cc.target_amount
       FROM contribution_cycles cc
       JOIN members m ON cc.chama_id = m.chama_id
       LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.status = 'paid'
       WHERE cc.id = ?`,
      [cycleId]
    );

    res.json({
      success: true,
      data: {
        cycle: cycle,
        summary: summary[0],
        members: membersContributions
      }
    });
  } catch (error) {
    console.error('❌ Get cycle details error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching cycle details'
    });
  }
};

/**
 * @desc    Update cycle status
 * @route   PUT /api/contributions/cycles/:cycleId/status
 * @access  Private (Admin only)
 */
const updateCycleStatus = async (req, res) => {
  const { cycleId } = req.params;
  const { status } = req.body;

  try {
    // Get cycle details
    const [cycles] = await db.execute(
      `SELECT chama_id FROM contribution_cycles WHERE id = ?`,
      [cycleId]
    );

    if (cycles.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cycle not found'
      });
    }

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [cycles[0].chama_id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // If activating a cycle, deactivate others
    if (status === 'active') {
      await db.execute(
        `UPDATE contribution_cycles 
         SET status = 'completed' 
         WHERE chama_id = ? AND status = 'active'`,
        [cycles[0].chama_id]
      );
    }

    // Update cycle status
    await db.execute(
      'UPDATE contribution_cycles SET status = ? WHERE id = ?',
      [status, cycleId]
    );

    // Get updated cycle
    const [updatedCycle] = await db.execute(
      'SELECT * FROM contribution_cycles WHERE id = ?',
      [cycleId]
    );

    res.json({
      success: true,
      message: 'Cycle status updated successfully',
      data: updatedCycle[0]
    });
  } catch (error) {
    console.error('❌ Update cycle status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating cycle status'
    });
  }
};

/**
 * @desc    Delete cycle
 * @route   DELETE /api/contributions/cycles/:cycleId
 * @access  Private (Admin only)
 */
const deleteCycle = async (req, res) => {
  const { cycleId } = req.params;

  try {
    // Get cycle details
    const [cycles] = await db.execute(
      `SELECT chama_id, status FROM contribution_cycles WHERE id = ?`,
      [cycleId]
    );

    if (cycles.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cycle not found'
      });
    }

    const cycle = cycles[0];

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [cycle.chama_id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Check if cycle has contributions
    const [contributions] = await db.execute(
      'SELECT COUNT(*) as count FROM contributions WHERE cycle_id = ?',
      [cycleId]
    );

    if (contributions[0].count > 0) {
      // Can't delete if has contributions, mark as cancelled instead
      if (cycle.status !== 'cancelled') {
        await db.execute(
          'UPDATE contribution_cycles SET status = "cancelled" WHERE id = ?',
          [cycleId]
        );
        
        res.json({
          success: true,
          message: 'Cycle cancelled (has existing contributions)'
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Cycle has contributions and is already cancelled'
        });
      }
    } else {
      // Delete cycle and associated types
      await db.execute('DELETE FROM cycle_types WHERE cycle_id = ?', [cycleId]);
      await db.execute('DELETE FROM contribution_cycles WHERE id = ?', [cycleId]);
      
      res.json({
        success: true,
        message: 'Cycle deleted successfully'
      });
    }
  } catch (error) {
    console.error('❌ Delete cycle error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting cycle'
    });
  }
};

// ============================================
// CONTRIBUTIONS CONTROLLERS
// ============================================

/**
 * @desc    Record contribution with balance management
 * @route   POST /api/contributions
 * @access  Private
 */
const recordContribution = async (req, res) => {
  const { 
    chamaId, 
    memberId, 
    cycleId, 
    typeId, 
    amount, 
    paymentMethod, 
    paymentReference,
    notes,
    applyToBalance = false
  } = req.body;

  try {
    // Validate
    if (!chamaId || !memberId || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: chamaId, memberId, amount'
      });
    }

    // Check permission
    const permission = await checkMemberPermission(req.user.id, memberId);
    if (!permission.authorized) {
      return res.status(403).json({
        success: false,
        message: permission.message
      });
    }

    let currentCycleId = cycleId;
    
    // If no cycleId provided, use current active cycle
    if (!currentCycleId) {
      const [activeCycles] = await db.execute(
        `SELECT id FROM contribution_cycles 
         WHERE chama_id = ? AND status = 'active'
         ORDER BY cycle_number DESC LIMIT 1`,
        [chamaId]
      );

      if (activeCycles.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No active contribution cycle found'
        });
      }
      currentCycleId = activeCycles[0].id;
    }

    // Get cycle details
    const [cycles] = await db.execute(
      `SELECT cc.*, 
              (SELECT SUM(amount) FROM cycle_types WHERE cycle_id = cc.id) as cycle_target
       FROM contribution_cycles cc
       WHERE cc.id = ?`,
      [currentCycleId]
    );

    if (cycles.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cycle not found'
      });
    }

    const cycle = cycles[0];

    // Calculate total expected for this cycle
    const [cycleTypes] = await db.execute(
      `SELECT ct.*, ct2.amount as expected_amount
       FROM cycle_types ct2
       JOIN contribution_types ct ON ct2.type_id = ct.id
       WHERE ct2.cycle_id = ?`,
      [currentCycleId]
    );

    const totalExpected = cycleTypes.reduce((sum, type) => sum + (parseFloat(type.expected_amount) || 0), 0);

    // Get member's current balance
    const [memberBalance] = await db.execute(
      `SELECT contribution_balance FROM members WHERE id = ?`,
      [memberId]
    );
    
    const currentBalance = memberBalance[0]?.contribution_balance || 0;

    // Payment processing logic
    let remainingPayment = parseFloat(amount);
    let contributions = [];
    let balanceAdjustment = 0;
    let rolloverAmount = 0;
    let nextCycleId = null;

    // 1. Apply to specific type if provided
    if (typeId && !applyToBalance) {
      const typeExpected = cycleTypes.find(t => t.id === parseInt(typeId))?.expected_amount || 0;
      
      const [existingContributions] = await db.execute(
        `SELECT * FROM contributions 
         WHERE member_id = ? AND cycle_id = ? AND type_id = ?`,
        [memberId, currentCycleId, typeId]
      );

      let alreadyPaid = existingContributions.reduce((sum, c) => sum + parseFloat(c.amount), 0);
      const remainingForType = Math.max(0, typeExpected - alreadyPaid);

      if (remainingPayment > 0 && remainingForType > 0) {
        const paymentForType = Math.min(remainingPayment, remainingForType);
        
        if (paymentForType > 0) {
          const contribution = await handleTypeContribution(
            memberId, currentCycleId, typeId, paymentForType, typeExpected,
            paymentMethod, paymentReference, req.user.id, existingContributions
          );
          contributions.push(contribution);
          remainingPayment -= paymentForType;
        }
      }
    }

    // 2. Apply to balance if requested
    if (applyToBalance && currentBalance < 0 && remainingPayment > 0) {
      const balanceToClear = Math.min(remainingPayment, Math.abs(currentBalance));
      
      if (balanceToClear > 0) {
        await updateMemberBalance(
          memberId,
          balanceToClear,
          `Balance clearance for cycle ${cycle.cycle_number}`,
          req.user.id,
          currentCycleId
        );
        
        balanceAdjustment = balanceToClear;
        remainingPayment -= balanceToClear;
      }
    }

    // 3. Apply to other types in cycle
    if (remainingPayment > 0 && !applyToBalance) {
      for (const type of cycleTypes) {
        if (remainingPayment <= 0) break;

        const [existingContributions] = await db.execute(
          `SELECT * FROM contributions 
           WHERE member_id = ? AND cycle_id = ? AND type_id = ?`,
          [memberId, currentCycleId, type.id]
        );

        const alreadyPaid = existingContributions.reduce((sum, c) => sum + parseFloat(c.amount), 0);
        const typeExpected = parseFloat(type.expected_amount);
        const remainingForType = Math.max(0, typeExpected - alreadyPaid);

        if (remainingForType > 0) {
          const paymentForType = Math.min(remainingPayment, remainingForType);
          
          if (paymentForType > 0) {
            const contribution = await handleTypeContribution(
              memberId, currentCycleId, type.id, paymentForType, typeExpected,
              paymentMethod, paymentReference, req.user.id, existingContributions
            );
            
            contributions.push(contribution);
            remainingPayment -= paymentForType;
          }
        }
      }
    }

    // 4. Handle overpayment (rollover to next cycle or balance)
    if (remainingPayment > 0) {
      // Check if there's a next cycle to rollover to
      const [nextCycles] = await db.execute(
        `SELECT id, cycle_number FROM contribution_cycles 
         WHERE chama_id = ? AND cycle_number > ? AND status IN ('upcoming', 'active')
         ORDER BY cycle_number ASC LIMIT 1`,
        [chamaId, cycle.cycle_number]
      );

      if (nextCycles.length > 0) {
        // Rollover to next cycle
        const nextCycle = nextCycles[0];
        nextCycleId = nextCycle.id;
        
        // Create rollover contribution
        const [rolloverResult] = await db.execute(
          `INSERT INTO contributions 
           (member_id, cycle_id, type_id, amount, expected_amount,
            payment_method, payment_reference, notes, recorded_by, status)
           VALUES (?, ?, NULL, ?, ?, 'rollover', ?, 'Rollover from cycle ${cycle.cycle_number}', ?, 'paid')`,
          [
            memberId,
            nextCycleId,
            remainingPayment,
            remainingPayment,
            paymentReference,
            req.user.id
          ]
        );

        // Update member balance for rollover
        await updateMemberBalance(
          memberId,
          remainingPayment,
          `Rollover to cycle ${nextCycle.cycle_number}`,
          req.user.id,
          currentCycleId,
          rolloverResult.insertId
        );

        rolloverAmount = remainingPayment;
        remainingPayment = 0;
      } else {
        // Add to member's positive balance
        await updateMemberBalance(
          memberId,
          remainingPayment,
          `Overpayment from cycle ${cycle.cycle_number}`,
          req.user.id,
          currentCycleId
        );
        
        balanceAdjustment += remainingPayment;
        remainingPayment = 0;
      }
    }

    // Update cycle collected amount
    const totalPaid = parseFloat(amount) - remainingPayment;
    if (totalPaid > 0) {
      await db.execute(
        `UPDATE contribution_cycles 
         SET collected_amount = collected_amount + ?
         WHERE id = ?`,
        [totalPaid, currentCycleId]
      );
    }

    // Record transaction
    await db.execute(
      `INSERT INTO transactions 
       (chama_id, transaction_type, amount, description, created_by) 
       VALUES (?, 'contribution', ?, ?, ?)`,
      [
        chamaId,
        totalPaid,
        `Contribution recorded: ${totalPaid} for cycle ${cycle.cycle_number}`,
        req.user.id
      ]
    );

    // Get updated member info
    const [memberInfo] = await db.execute(
      `SELECT m.*, u.name, u.phone, m.contribution_balance
       FROM members m
       JOIN users u ON m.user_id = u.id
       WHERE m.id = ?`,
      [memberId]
    );

    // Get all contributions for this payment
    const contributionIds = contributions.map(c => c.id);
    let allContributions = [];
    
    if (contributionIds.length > 0) {
      const [contribs] = await db.execute(
        `SELECT c.*, ct.name as type_name
         FROM contributions c
         LEFT JOIN contribution_types ct ON c.type_id = ct.id
         WHERE c.id IN (${contributionIds.join(',')})`
      );
      allContributions = contribs;
    }

    // Get updated balance
    const [updatedBalance] = await db.execute(
      'SELECT contribution_balance FROM members WHERE id = ?',
      [memberId]
    );

    res.status(201).json({
      success: true,
      message: 'Contribution recorded successfully',
      data: {
        member: memberInfo[0],
        cycle: {
          id: currentCycleId,
          cycle_number: cycle.cycle_number,
          cycle_name: cycle.cycle_name
        },
        payment_summary: {
          total_paid: parseFloat(amount),
          applied_to_contributions: parseFloat(amount) - remainingPayment - rolloverAmount - balanceAdjustment,
          applied_to_balance: balanceAdjustment,
          rollover_amount: rolloverAmount,
          remaining_unallocated: remainingPayment,
          new_balance: updatedBalance[0]?.contribution_balance || 0
        },
        contributions: allContributions,
        rollover: rolloverAmount > 0 ? {
          amount: rolloverAmount,
          next_cycle_id: nextCycleId
        } : null
      }
    });

  } catch (error) {
    console.error('❌ Record contribution error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error recording contribution',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * @desc    Update contribution
 * @route   PUT /api/contributions/:contributionId
 * @access  Private (Admin only)
 */
const updateContribution = async (req, res) => {
  const { contributionId } = req.params;
  const { amount, paymentMethod, paymentReference, notes, status } = req.body;

  try {
    // Get contribution details
    const [contributions] = await db.execute(
      `SELECT c.*, m.chama_id, m.contribution_balance as member_balance
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE c.id = ?`,
      [contributionId]
    );

    if (contributions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contribution not found'
      });
    }

    const contribution = contributions[0];

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [contribution.chama_id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Calculate balance adjustment if amount changed
    let balanceAdjustment = 0;
    const oldAmount = parseFloat(contribution.amount);
    const newAmount = amount !== undefined ? parseFloat(amount) : oldAmount;

    if (amount !== undefined && oldAmount !== newAmount) {
      balanceAdjustment = newAmount - oldAmount;
      
      // Update member balance
      await updateMemberBalance(
        contribution.member_id,
        balanceAdjustment,
        `Contribution adjustment: ${oldAmount} → ${newAmount}`,
        req.user.id,
        contribution.cycle_id,
        contributionId
      );
    }

    // Build update query
    const updates = [];
    const params = [];

    if (amount !== undefined) {
      updates.push('amount = ?');
      params.push(newAmount);
    }

    if (paymentMethod !== undefined) {
      updates.push('payment_method = ?');
      params.push(paymentMethod);
    }

    if (paymentReference !== undefined) {
      updates.push('payment_reference = ?');
      params.push(paymentReference);
    }

    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes);
    }

    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
      
      if (status === 'paid' && !contribution.verified_by) {
        updates.push('verified_by = ?, verification_date = CURRENT_TIMESTAMP');
        params.push(req.user.id);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(contributionId);

      await db.execute(
        `UPDATE contributions SET ${updates.join(', ')} WHERE id = ?`,
        params
      );

      // Update cycle collected amount if amount changed
      if (amount !== undefined) {
        await db.execute(
          `UPDATE contribution_cycles cc
           SET collected_amount = (
             SELECT COALESCE(SUM(amount), 0) 
             FROM contributions 
             WHERE cycle_id = cc.id AND status = 'paid'
           )
           WHERE cc.id = ?`,
          [contribution.cycle_id]
        );
      }
    }

    // Get updated contribution
    const [updatedContribution] = await db.execute(
      `SELECT c.*, u.name as member_name, ct.name as type_name
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       JOIN users u ON m.user_id = u.id
       LEFT JOIN contribution_types ct ON c.type_id = ct.id
       WHERE c.id = ?`,
      [contributionId]
    );

    // Get updated member balance
    const [memberBalance] = await db.execute(
      'SELECT contribution_balance FROM members WHERE id = ?',
      [contribution.member_id]
    );

    res.json({
      success: true,
      message: 'Contribution updated successfully',
      data: {
        contribution: updatedContribution[0],
        balance_adjustment: balanceAdjustment,
        new_member_balance: memberBalance[0]?.contribution_balance || 0
      }
    });
  } catch (error) {
    console.error('❌ Update contribution error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating contribution'
    });
  }
};

/**
 * @desc    Delete contribution
 * @route   DELETE /api/contributions/:contributionId
 * @access  Private (Admin only)
 */
const deleteContribution = async (req, res) => {
  const { contributionId } = req.params;

  try {
    // Get contribution details
    const [contributions] = await db.execute(
      `SELECT c.*, m.chama_id, m.contribution_balance as member_balance
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE c.id = ?`,
      [contributionId]
    );

    if (contributions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contribution not found'
      });
    }

    const contribution = contributions[0];

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [contribution.chama_id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Adjust member balance (reverse the contribution)
    const amount = parseFloat(contribution.amount);
    await updateMemberBalance(
      contribution.member_id,
      -amount,
      `Contribution deleted: ${amount}`,
      req.user.id,
      contribution.cycle_id,
      contributionId
    );

    // Update cycle collected amount
    if (contribution.status === 'paid') {
      await db.execute(
        `UPDATE contribution_cycles 
         SET collected_amount = GREATEST(0, collected_amount - ?)
         WHERE id = ?`,
        [amount, contribution.cycle_id]
      );
    }

    // Delete contribution
    await db.execute('DELETE FROM contributions WHERE id = ?', [contributionId]);

    // Get updated member balance
    const [memberBalance] = await db.execute(
      'SELECT contribution_balance FROM members WHERE id = ?',
      [contribution.member_id]
    );

    res.json({
      success: true,
      message: 'Contribution deleted successfully',
      data: {
        deleted_amount: amount,
        new_member_balance: memberBalance[0]?.contribution_balance || 0
      }
    });
  } catch (error) {
    console.error('❌ Delete contribution error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting contribution'
    });
  }
};

/**
 * @desc    Get contribution by ID
 * @route   GET /api/contributions/:contributionId
 * @access  Private (Members)
 */
const getContributionById = async (req, res) => {
  try {
    const { contributionId } = req.params;

    const [contributions] = await db.execute(
      `SELECT c.*, u.name as member_name, u.phone as member_phone,
              cy.cycle_number, cy.cycle_name, cy.due_date,
              ct.name as type_name, ct.description as type_description,
              m.role as member_role, m.chama_id,
              ru.name as recorded_by_name,
              vu.name as verified_by_name
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       JOIN users u ON m.user_id = u.id
       JOIN contribution_cycles cy ON c.cycle_id = cy.id
       LEFT JOIN contribution_types ct ON c.type_id = ct.id
       LEFT JOIN users ru ON c.recorded_by = ru.id
       LEFT JOIN users vu ON c.verified_by = vu.id
       WHERE c.id = ?`,
      [contributionId]
    );

    if (contributions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contribution not found'
      });
    }

    const contribution = contributions[0];

    // Check membership
    const [membership] = await db.execute(
      'SELECT id FROM members WHERE chama_id = ? AND user_id = ?',
      [contribution.chama_id, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    res.json({
      success: true,
      data: contribution
    });
  } catch (error) {
    console.error('❌ Get contribution error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching contribution'
    });
  }
};

/**
 * @desc    Get contributions for a chama
 * @route   GET /api/contributions/chama/:chamaId
 * @access  Private (Members)
 */
const getChamaContributions = async (req, res) => {
  try {
    const { chamaId } = req.params;
    const { cycleId, memberId, status, startDate, endDate, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // Check membership
    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view contributions for this chama'
      });
    }

    // Build query
    let query = `
      SELECT c.*, u.name as member_name, u.phone as member_phone,
             cy.cycle_number, cy.cycle_name, cy.due_date,
             ct.name as type_name,
             m.role as member_role,
             ru.name as recorded_by_name
      FROM contributions c
      JOIN members m ON c.member_id = m.id
      JOIN users u ON m.user_id = u.id
      JOIN contribution_cycles cy ON c.cycle_id = cy.id
      LEFT JOIN contribution_types ct ON c.type_id = ct.id
      LEFT JOIN users ru ON c.recorded_by = ru.id
      WHERE m.chama_id = ?
    `;
    
    let countQuery = `
      SELECT COUNT(*) as total
      FROM contributions c
      JOIN members m ON c.member_id = m.id
      WHERE m.chama_id = ?
    `;
    
    const params = [chamaId];
    const countParams = [chamaId];

    if (cycleId) {
      query += ' AND c.cycle_id = ?';
      countQuery += ' AND c.cycle_id = ?';
      params.push(cycleId);
      countParams.push(cycleId);
    }

    if (memberId) {
      query += ' AND c.member_id = ?';
      countQuery += ' AND c.member_id = ?';
      params.push(memberId);
      countParams.push(memberId);
    }

    if (status) {
      query += ' AND c.status = ?';
      countQuery += ' AND c.status = ?';
      params.push(status);
      countParams.push(status);
    }

    if (startDate) {
      query += ' AND DATE(c.payment_date) >= ?';
      countQuery += ' AND DATE(c.payment_date) >= ?';
      params.push(startDate);
      countParams.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(c.payment_date) <= ?';
      countQuery += ' AND DATE(c.payment_date) <= ?';
      params.push(endDate);
      countParams.push(endDate);
    }

    query += ' ORDER BY c.payment_date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [contributions] = await db.execute(query, params);
    const [totalCount] = await db.execute(countQuery, countParams);

    // Get summary
    const [summary] = await db.execute(
      `SELECT 
         COUNT(*) as total_contributions,
         SUM(amount) as total_amount,
         COUNT(DISTINCT member_id) as unique_members,
         AVG(amount) as average_contribution
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE m.chama_id = ? AND c.status = 'paid'
       ${cycleId ? ' AND c.cycle_id = ?' : ''}`,
      cycleId ? [chamaId, cycleId] : [chamaId]
    );

    res.json({
      success: true,
      count: contributions.length,
      summary: summary[0],
      data: contributions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount[0].total,
        pages: Math.ceil(totalCount[0].total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Get chama contributions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching contributions'
    });
  }
};

/**
 * @desc    Get member contributions
 * @route   GET /api/contributions/member/:memberId
 * @access  Private (Self or Admin)
 */
const getMemberContributions = async (req, res) => {
  try {
    const { memberId } = req.params;
    const { cycleId, status, startDate, endDate, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // Check permission
    const permission = await checkMemberPermission(req.user.id, memberId);
    if (!permission.authorized) {
      return res.status(403).json({
        success: false,
        message: permission.message
      });
    }

    const member = permission.member;

    // Build query
    let query = `
      SELECT c.*, cy.cycle_number, cy.cycle_name, cy.due_date,
             ct.name as type_name, ct.description as type_description,
             ru.name as recorded_by_name,
             vu.name as verified_by_name
      FROM contributions c
      JOIN contribution_cycles cy ON c.cycle_id = cy.id
      LEFT JOIN contribution_types ct ON c.type_id = ct.id
      LEFT JOIN users ru ON c.recorded_by = ru.id
      LEFT JOIN users vu ON c.verified_by = vu.id
      WHERE c.member_id = ?
    `;
    
    let countQuery = `
      SELECT COUNT(*) as total
      FROM contributions
      WHERE member_id = ?
    `;
    
    const params = [memberId];
    const countParams = [memberId];

    if (cycleId) {
      query += ' AND c.cycle_id = ?';
      countQuery += ' AND cycle_id = ?';
      params.push(cycleId);
      countParams.push(cycleId);
    }

    if (status) {
      query += ' AND c.status = ?';
      countQuery += ' AND status = ?';
      params.push(status);
      countParams.push(status);
    }

    if (startDate) {
      query += ' AND DATE(c.payment_date) >= ?';
      countQuery += ' AND DATE(payment_date) >= ?';
      params.push(startDate);
      countParams.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(c.payment_date) <= ?';
      countQuery += ' AND DATE(payment_date) <= ?';
      params.push(endDate);
      countParams.push(endDate);
    }

    query += ' ORDER BY c.payment_date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [contributions] = await db.execute(query, params);
    const [totalCount] = await db.execute(countQuery, countParams);

    // Get summary
    const [summary] = await db.execute(
      `SELECT 
         COUNT(*) as total_contributions,
         SUM(amount) as total_amount,
         COUNT(DISTINCT cycle_id) as cycles_contributed,
         AVG(amount) as average_contribution,
         MIN(payment_date) as first_contribution,
         MAX(payment_date) as last_contribution
       FROM contributions 
       WHERE member_id = ? AND status = 'paid'`,
      [memberId]
    );

    // Get member info with balance
    const [memberInfo] = await db.execute(
      `SELECT m.*, u.name, u.phone, c.name as chama_name
       FROM members m
       JOIN users u ON m.user_id = u.id
       JOIN chamas c ON m.chama_id = c.id
       WHERE m.id = ?`,
      [memberId]
    );

    res.json({
      success: true,
      member: memberInfo[0],
      summary: summary[0],
      data: contributions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount[0].total,
        pages: Math.ceil(totalCount[0].total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Get member contributions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching member contributions'
    });
  }
};

/**
 * @desc    Update contribution status (legacy)
 * @route   PUT /api/contributions/:contributionId/status
 * @access  Private (Admin only)
 */
const updateContributionStatus = async (req, res) => {
  const { contributionId } = req.params;
  const { status } = req.body;

  try {
    // Get contribution details
    const [contributions] = await db.execute(
      `SELECT c.*, m.chama_id
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE c.id = ?`,
      [contributionId]
    );

    if (contributions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contribution not found'
      });
    }

    const contribution = contributions[0];

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [contribution.chama_id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Update status
    await db.execute(
      'UPDATE contributions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, contributionId]
    );

    // Record transaction if marked as paid and not already paid
    if (status === 'paid' && contribution.status !== 'paid') {
      await db.execute(
        `INSERT INTO transactions 
         (chama_id, transaction_type, amount, description, created_by) 
         VALUES (?, 'contribution', ?, ?, ?)`,
        [
          contribution.chama_id,
          contribution.amount,
          `Contribution status updated to paid for member ID: ${contribution.member_id}`,
          req.user.id
        ]
      );

      // Update member balance
      await updateMemberBalance(
        contribution.member_id,
        contribution.amount,
        `Contribution marked as paid for cycle`,
        req.user.id,
        contribution.cycle_id,
        contributionId
      );

      // Update cycle collected amount
      await db.execute(
        `UPDATE contribution_cycles 
         SET collected_amount = collected_amount + ?
         WHERE id = ?`,
        [contribution.amount, contribution.cycle_id]
      );
    }

    res.json({
      success: true,
      message: 'Contribution status updated successfully'
    });
  } catch (error) {
    console.error('❌ Update contribution status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating contribution status'
    });
  }
};

// ============================================
// MEMBER STATUS & REPORTS CONTROLLERS
// ============================================

/**
 * @desc    Get member's contribution status with balance
 * @route   GET /api/contributions/member/:memberId/status
 * @access  Private (Self or Admin)
 */
const getMemberContributionStatus = async (req, res) => {
  try {
    const { memberId } = req.params;

    // Check permission
    const permission = await checkMemberPermission(req.user.id, memberId);
    if (!permission.authorized) {
      return res.status(403).json({
        success: false,
        message: permission.message
      });
    }

    const member = permission.member;

    // Get member details with balance
    const [memberDetails] = await db.execute(
      `SELECT m.*, u.name, u.phone, u.email, c.name as chama_name
       FROM members m
       JOIN users u ON m.user_id = u.id
       JOIN chamas c ON m.chama_id = c.id
       WHERE m.id = ?`,
      [memberId]
    );

    if (memberDetails.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    const memberInfo = memberDetails[0];

    // Get active cycle
    const [activeCycles] = await db.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC LIMIT 1`,
      [member.chama_id]
    );

    let cycleStatus = null;
    const activeCycle = activeCycles[0];

    if (activeCycle) {
      // Get cycle types
      const [cycleTypes] = await db.execute(
        `SELECT ct.*, ct2.amount as expected_amount
         FROM cycle_types ct2
         JOIN contribution_types ct ON ct2.type_id = ct.id
         WHERE ct2.cycle_id = ?`,
        [activeCycle.id]
      );

      // Get member's contributions for this cycle
      const [contributions] = await db.execute(
        `SELECT c.*, ct.name as type_name
         FROM contributions c
         LEFT JOIN contribution_types ct ON c.type_id = ct.id
         WHERE c.member_id = ? AND c.cycle_id = ?`,
        [memberId, activeCycle.id]
      );

      // Calculate totals
      const totalExpected = cycleTypes.reduce((sum, t) => sum + (parseFloat(t.expected_amount) || 0), 0);
      const totalPaid = contributions.filter(c => c.status === 'paid')
        .reduce((sum, c) => sum + parseFloat(c.amount), 0);
      const totalOutstanding = Math.max(0, totalExpected - totalPaid);

      // Get overdue status
      const isOverdue = new Date(activeCycle.due_date) < new Date() && totalOutstanding > 0;

      // Calculate per-type status
      const typeStatus = cycleTypes.map(type => {
        const typeContributions = contributions.filter(c => c.type_id === type.id);
        const paidForType = typeContributions
          .filter(c => c.status === 'paid')
          .reduce((sum, c) => sum + parseFloat(c.amount), 0);
        const expected = parseFloat(type.expected_amount);
        const remaining = Math.max(0, expected - paidForType);
        const status = remaining === 0 ? 'paid' : (paidForType > 0 ? 'partial' : 'pending');

        return {
          type_id: type.id,
          type_name: type.name,
          expected_amount: expected,
          paid_amount: paidForType,
          remaining_amount: remaining,
          status: status,
          contributions: typeContributions
        };
      });

      cycleStatus = {
        cycle: activeCycle,
        total_expected: totalExpected,
        total_paid: totalPaid,
        total_outstanding: totalOutstanding,
        is_overdue: isOverdue,
        payment_status: totalOutstanding === 0 ? 'paid' : (totalPaid > 0 ? 'partial' : 'pending'),
        type_breakdown: typeStatus,
        due_date: activeCycle.due_date,
        days_remaining: Math.max(0, Math.ceil((new Date(activeCycle.due_date) - new Date()) / (1000 * 60 * 60 * 24)))
      };
    }

    // Get upcoming cycles
    const [upcomingCycles] = await db.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'upcoming'
       ORDER BY cycle_number ASC`,
      [member.chama_id]
    );

    // Get recent payment history
    const [paymentHistory] = await db.execute(
      `SELECT c.*, cc.cycle_number, cc.cycle_name, ct.name as type_name
       FROM contributions c
       JOIN contribution_cycles cc ON c.cycle_id = cc.id
       LEFT JOIN contribution_types ct ON c.type_id = ct.id
       WHERE c.member_id = ? AND c.status = 'paid'
       ORDER BY c.payment_date DESC
       LIMIT 10`,
      [memberId]
    );

    // Get ledger entries if table exists
    let ledgerEntries = [];
    try {
      const [ledger] = await db.execute(
        `SELECT * FROM contribution_ledger 
         WHERE member_id = ?
         ORDER BY created_at DESC
         LIMIT 10`,
        [memberId]
      );
      ledgerEntries = ledger;
    } catch (error) {
      console.log('Ledger table not available');
    }

    // Calculate overall statistics
    const [overallStats] = await db.execute(
      `SELECT 
         COUNT(DISTINCT c.cycle_id) as total_cycles,
         COUNT(c.id) as total_contributions,
         SUM(c.amount) as total_contributed,
         AVG(c.amount) as average_contribution,
         SUM(CASE WHEN c.status = 'late' THEN 1 ELSE 0 END) as late_payments,
         SUM(CASE WHEN c.status IN ('pending', 'partial') AND cc.due_date < CURDATE() THEN 1 ELSE 0 END) as overdue_payments
       FROM contributions c
       JOIN contribution_cycles cc ON c.cycle_id = cc.id
       WHERE c.member_id = ?`,
      [memberId]
    );

    res.json({
      success: true,
      data: {
        member: {
          id: memberInfo.id,
          name: memberInfo.name,
          phone: memberInfo.phone,
          email: memberInfo.email,
          role: memberInfo.role,
          contribution_balance: memberInfo.contribution_balance,
          chama_name: memberInfo.chama_name,
          join_date: memberInfo.join_date
        },
        active_cycle: cycleStatus,
        upcoming_cycles: upcomingCycles,
        payment_history: paymentHistory,
        ledger_entries: ledgerEntries,
        overall_statistics: overallStats[0],
        summary: {
          current_balance: memberInfo.contribution_balance,
          balance_status: memberInfo.contribution_balance >= 0 ? 'credit' : 'arrears',
          total_credit: Math.max(0, memberInfo.contribution_balance),
          total_arrears: Math.max(0, -memberInfo.contribution_balance)
        }
      }
    });

  } catch (error) {
    console.error('❌ Get member status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching member status'
    });
  }
};

/**
 * @desc    Get contribution summary
 * @route   GET /api/contributions/summary/:chamaId/:memberId?
 * @access  Private
 */
const getContributionSummary = async (req, res) => {
  try {
    const { chamaId, memberId } = req.params;
    const targetMemberId = memberId || req.user.id;

    // Check membership for chama
    const [membership] = await db.execute(
      `SELECT m.id, m.role 
       FROM members m
       WHERE m.chama_id = ? AND m.user_id = ?`,
      [chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    const isAdmin = membership[0].role === 'admin';
    const isSelf = !memberId || membership[0].id === parseInt(memberId);

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this summary'
      });
    }

    // Get member info if specific member requested
    let memberInfo = null;
    if (memberId) {
      const [memberData] = await db.execute(
        `SELECT m.*, u.name, u.phone 
         FROM members m
         JOIN users u ON m.user_id = u.id
         WHERE m.chama_id = ? AND m.id = ?`,
        [chamaId, targetMemberId]
      );

      if (memberData.length > 0) {
        memberInfo = memberData[0];
      }
    }

    // Get overall summary
    const [summary] = await db.execute(
      `SELECT 
         COUNT(DISTINCT cc.id) as total_cycles,
         COUNT(DISTINCT c.cycle_id) as cycles_contributed,
         SUM(c.amount) as total_contributed,
         AVG(c.amount) as average_contribution,
         MIN(c.payment_date) as first_contribution,
         MAX(c.payment_date) as last_contribution,
         SUM(CASE WHEN c.status = 'late' THEN 1 ELSE 0 END) as late_payments,
         SUM(CASE WHEN c.status = 'pending' AND cc.due_date < CURDATE() THEN 1 ELSE 0 END) as overdue_payments,
         (SELECT contribution_balance FROM members WHERE id = ?) as current_balance
       FROM contribution_cycles cc
       LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.member_id = ?
       WHERE cc.chama_id = ?`,
      [targetMemberId, targetMemberId, chamaId]
    );

    // Get current cycle status
    const [currentCycle] = await db.execute(
      `SELECT cc.id, cc.cycle_number, cc.cycle_name, cc.due_date,
              c.status as contribution_status,
              c.amount as paid_amount,
              (SELECT SUM(amount) FROM cycle_types WHERE cycle_id = cc.id) as expected_amount
       FROM contribution_cycles cc
       LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.member_id = ?
       WHERE cc.chama_id = ? AND cc.status = 'active'
       ORDER BY cc.cycle_number DESC
       LIMIT 1`,
      [targetMemberId, chamaId]
    );

    // Get contribution history
    const [history] = await db.execute(
      `SELECT cc.cycle_number, cc.cycle_name, cc.cycle_date, cc.due_date,
              c.amount, c.status, c.payment_date, c.payment_method,
              ct.name as type_name
       FROM contribution_cycles cc
       LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.member_id = ?
       LEFT JOIN contribution_types ct ON c.type_id = ct.id
       WHERE cc.chama_id = ?
       ORDER BY cc.cycle_number DESC
       LIMIT 10`,
      [targetMemberId, chamaId]
    );

    // Get monthly breakdown
    const [monthlyBreakdown] = await db.execute(
      `SELECT 
         DATE_FORMAT(c.payment_date, '%Y-%m') as month,
         COUNT(*) as contribution_count,
         SUM(c.amount) as total_amount,
         AVG(c.amount) as average_amount
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE m.chama_id = ? AND c.member_id = ? AND c.status = 'paid'
       GROUP BY DATE_FORMAT(c.payment_date, '%Y-%m')
       ORDER BY month DESC
       LIMIT 6`,
      [chamaId, targetMemberId]
    );

    res.json({
      success: true,
      data: {
        member: memberInfo,
        summary: summary[0],
        currentCycle: currentCycle[0] || null,
        history: history,
        monthlyBreakdown: monthlyBreakdown,
        filters: {
          chamaId,
          memberId: memberId || 'self'
        }
      }
    });
  } catch (error) {
    console.error('❌ Get contribution summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching contribution summary'
    });
  }
};

/**
 * @desc    Get chama-wide contribution report
 * @route   GET /api/contributions/report/:chamaId
 * @access  Private (Admin only)
 */
const getContributionReport = async (req, res) => {
  try {
    const { chamaId } = req.params;
    const { startDate, endDate, cycleId, status } = req.query;

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [chamaId, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Build member report query
    let query = `
      SELECT 
        m.id as member_id,
        u.name as member_name,
        u.phone,
        m.role,
        m.contribution_balance,
        COUNT(DISTINCT c.id) as total_contributions,
        SUM(CASE WHEN c.status = 'paid' THEN c.amount ELSE 0 END) as total_paid,
        SUM(CASE WHEN c.status IN ('pending', 'partial') THEN c.expected_amount - c.amount ELSE 0 END) as total_outstanding,
        MIN(c.payment_date) as first_payment,
        MAX(c.payment_date) as last_payment,
        COUNT(DISTINCT CASE WHEN c.status = 'paid' THEN c.cycle_id END) as cycles_paid
      FROM members m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN contributions c ON m.id = c.member_id
      LEFT JOIN contribution_cycles cc ON c.cycle_id = cc.id
      WHERE m.chama_id = ?
    `;

    const params = [chamaId];

    if (startDate) {
      query += ' AND DATE(c.payment_date) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(c.payment_date) <= ?';
      params.push(endDate);
    }

    if (cycleId) {
      query += ' AND c.cycle_id = ?';
      params.push(cycleId);
    }

    if (status) {
      query += ' AND c.status = ?';
      params.push(status);
    }

    query += ' GROUP BY m.id ORDER BY m.role DESC, u.name';

    const [report] = await db.execute(query, params);

    // Get summary statistics
    const summary = report.reduce((acc, member) => {
      acc.total_members++;
      acc.total_balance += parseFloat(member.contribution_balance || 0);
      acc.total_paid += parseFloat(member.total_paid || 0);
      acc.total_outstanding += parseFloat(member.total_outstanding || 0);
      
      if (member.contribution_balance < 0) {
        acc.members_in_arrears++;
        acc.total_arrears += Math.abs(parseFloat(member.contribution_balance));
      } else if (member.contribution_balance > 0) {
        acc.members_with_credit++;
        acc.total_credit += parseFloat(member.contribution_balance);
      }
      
      // Calculate compliance rate
      if (cycleId) {
        // For specific cycle
        const [cycleStats] = db.execute(
          `SELECT COUNT(*) as total_members FROM members WHERE chama_id = ?`,
          [chamaId]
        );
        acc.compliance_rate = (member.cycles_paid / 1) * 100; // For single cycle
      } else {
        // For all cycles
        const [totalCycles] = db.execute(
          `SELECT COUNT(*) as total_cycles FROM contribution_cycles WHERE chama_id = ?`,
          [chamaId]
        );
        acc.total_cycles = totalCycles[0]?.total_cycles || 0;
      }
      
      return acc;
    }, {
      total_members: 0,
      total_paid: 0,
      total_outstanding: 0,
      total_balance: 0,
      members_in_arrears: 0,
      members_with_credit: 0,
      total_arrears: 0,
      total_credit: 0,
      compliance_rate: 0
    });

    // Get cycle-wise breakdown if no specific cycle
    let cycleBreakdown = [];
    if (!cycleId) {
      const [cycles] = await db.execute(
        `SELECT 
           cc.id,
           cc.cycle_number,
           cc.cycle_name,
           cc.cycle_date,
           cc.due_date,
           cc.status,
           COUNT(DISTINCT c.member_id) as members_paid,
           COUNT(DISTINCT m.id) as total_members,
           SUM(c.amount) as total_collected,
           (SELECT SUM(amount) FROM cycle_types WHERE cycle_id = cc.id) as total_expected
         FROM contribution_cycles cc
         LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.status = 'paid'
         LEFT JOIN members m ON cc.chama_id = m.chama_id
         WHERE cc.chama_id = ?
         GROUP BY cc.id
         ORDER BY cc.cycle_number DESC`,
        [chamaId]
      );
      cycleBreakdown = cycles;
    }

    // Get payment method breakdown
    const [paymentMethods] = await db.execute(
      `SELECT 
         c.payment_method,
         COUNT(*) as transaction_count,
         SUM(c.amount) as total_amount,
         AVG(c.amount) as average_amount
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE m.chama_id = ? AND c.status = 'paid'
       GROUP BY c.payment_method
       ORDER BY total_amount DESC`,
      [chamaId]
    );

    // Get monthly trends
    const [monthlyTrends] = await db.execute(
      `SELECT 
         DATE_FORMAT(c.payment_date, '%Y-%m') as month,
         COUNT(*) as contribution_count,
         SUM(c.amount) as total_amount,
         COUNT(DISTINCT c.member_id) as unique_members
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE m.chama_id = ? AND c.status = 'paid'
       GROUP BY DATE_FORMAT(c.payment_date, '%Y-%m')
       ORDER BY month DESC
       LIMIT 12`,
      [chamaId]
    );

    res.json({
      success: true,
      data: {
        summary: summary,
        members: report,
        cycle_breakdown: cycleBreakdown,
        payment_methods: paymentMethods,
        monthly_trends: monthlyTrends,
        filters: {
          startDate,
          endDate,
          cycleId,
          status
        }
      }
    });
  } catch (error) {
    console.error('❌ Get report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error generating report'
    });
  }
};

// ============================================
// BALANCE MANAGEMENT CONTROLLERS
// ============================================

/**
 * @desc    Adjust member balance
 * @route   POST /api/contributions/balance/adjust
 * @access  Private (Admin only)
 */
const adjustMemberBalance = async (req, res) => {
  const { memberId, amount, reason } = req.body;

  try {
    if (!memberId || amount === undefined || !reason) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: memberId, amount, reason'
      });
    }

    // Check admin permission
    const permission = await checkMemberPermission(req.user.id, memberId, true);
    if (!permission.authorized) {
      return res.status(403).json({
        success: false,
        message: permission.message
      });
    }

    const member = permission.member;

    // Update balance
    const newBalance = await updateMemberBalance(
      memberId,
      parseFloat(amount),
      reason,
      req.user.id,
      null
    );

    // Record adjustment transaction
    await db.execute(
      `INSERT INTO transactions 
       (chama_id, transaction_type, amount, description, created_by) 
       VALUES (?, 'adjustment', ?, ?, ?)`,
      [
        member.chama_id,
        amount,
        `Balance adjustment: ${reason}`,
        req.user.id
      ]
    );

    res.json({
      success: true,
      message: 'Balance adjusted successfully',
      data: {
        member_id: memberId,
        member_name: member.name,
        adjustment: amount,
        previous_balance: newBalance - amount,
        new_balance: newBalance,
        reason: reason
      }
    });

  } catch (error) {
    console.error('❌ Adjust balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error adjusting balance'
    });
  }
};

/**
 * @desc    Get member balance history
 * @route   GET /api/contributions/balance/history/:memberId
 * @access  Private (Self or Admin)
 */
const getMemberBalanceHistory = async (req, res) => {
  try {
    const { memberId } = req.params;

    // Check permission
    const permission = await checkMemberPermission(req.user.id, memberId);
    if (!permission.authorized) {
      return res.status(403).json({
        success: false,
        message: permission.message
      });
    }

    // Get ledger entries if table exists
    let ledgerEntries = [];
    try {
      const [ledger] = await db.execute(
        `SELECT cl.*, 
                u.name as created_by_name,
                cc.cycle_number,
                ct.name as type_name
         FROM contribution_ledger cl
         LEFT JOIN users u ON cl.created_by = u.id
         LEFT JOIN contribution_cycles cc ON cl.cycle_id = cc.id
         LEFT JOIN contributions c ON cl.contribution_id = c.id
         LEFT JOIN contribution_types ct ON c.type_id = ct.id
         WHERE cl.member_id = ?
         ORDER BY cl.created_at DESC
         LIMIT 50`,
        [memberId]
      );
      ledgerEntries = ledger;
    } catch (error) {
      console.log('Ledger table not available, using fallback');
      
      // Fallback: get from contributions
      const [contributions] = await db.execute(
        `SELECT 
           c.payment_date as created_at,
           c.amount,
           c.expected_amount,
           c.status,
           c.payment_method,
           ct.name as type_name,
           cc.cycle_number,
           'contribution' as transaction_type,
           CONCAT('Contribution for ', ct.name) as description,
           u.name as created_by_name
         FROM contributions c
         LEFT JOIN contribution_types ct ON c.type_id = ct.id
         LEFT JOIN contribution_cycles cc ON c.cycle_id = cc.id
         LEFT JOIN users u ON c.recorded_by = u.id
         WHERE c.member_id = ?
         ORDER BY c.payment_date DESC
         LIMIT 50`,
        [memberId]
      );
      ledgerEntries = contributions;
    }

    // Get current balance
    const [memberBalance] = await db.execute(
      'SELECT contribution_balance FROM members WHERE id = ?',
      [memberId]
    );

    // Calculate balance changes over time
    let runningBalance = 0;
    const balanceHistory = ledgerEntries.map(entry => {
      runningBalance += parseFloat(entry.amount || 0);
      return {
        ...entry,
        running_balance: runningBalance
      };
    }).reverse(); // Reverse to show chronological order

    res.json({
      success: true,
      data: {
        current_balance: memberBalance[0]?.contribution_balance || 0,
        history: balanceHistory,
        total_entries: balanceHistory.length
      }
    });
  } catch (error) {
    console.error('❌ Get balance history error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching balance history'
    });
  }
};

// ============================================
// SCHEDULED & BULK OPERATIONS CONTROLLERS
// ============================================

/**
 * @desc    Process scheduled contributions
 * @route   POST /api/contributions/process-scheduled
 * @access  Private (Admin only)
 */
const processScheduledContributions = async (req, res) => {
  try {
    const { chamaId } = req.body;

    if (!chamaId) {
      return res.status(400).json({
        success: false,
        message: 'Chama ID is required'
      });
    }

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [chamaId, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Get active cycle
    const [activeCycles] = await db.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC LIMIT 1`,
      [chamaId]
    );

    if (activeCycles.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active cycle found'
      });
    }

    const activeCycle = activeCycles[0];

    // Get all members with their balances
    const [members] = await db.execute(
      `SELECT m.*, u.name, u.phone, m.contribution_balance
       FROM members m
       JOIN users u ON m.user_id = u.id
       WHERE m.chama_id = ? AND m.status = 'active'`,
      [chamaId]
    );

    // Get cycle total expected
    const [cycleTypes] = await db.execute(
      `SELECT SUM(amount) as total_expected 
       FROM cycle_types 
       WHERE cycle_id = ?`,
      [activeCycle.id]
    );
    
    const totalExpected = cycleTypes[0]?.total_expected || 0;

    const results = {
      processed: 0,
      skipped: 0,
      failed: 0,
      total_members: members.length,
      details: []
    };

    // Process each member
    for (const member of members) {
      try {
        // Check if already paid for this cycle
        const [existingContributions] = await db.execute(
          `SELECT SUM(amount) as total_paid, COUNT(*) as count
           FROM contributions 
           WHERE member_id = ? AND cycle_id = ? AND status = 'paid'`,
          [member.id, activeCycle.id]
        );

        const alreadyPaid = existingContributions[0]?.total_paid || 0;
        const remainingToPay = Math.max(0, totalExpected - alreadyPaid);

        if (remainingToPay <= 0) {
          // Already fully paid
          results.skipped++;
          results.details.push({
            member_id: member.id,
            member_name: member.name,
            status: 'already_paid',
            amount_paid: alreadyPaid
          });
          continue;
        }

        // Check if member has sufficient credit balance
        if (member.contribution_balance >= remainingToPay) {
          // Use balance to cover contribution
          await updateMemberBalance(
            member.id,
            -remainingToPay, // Deduct from balance
            `Automatic contribution for cycle ${activeCycle.cycle_number}`,
            req.user.id,
            activeCycle.id
          );

          // Record contributions as paid from balance
          const [types] = await db.execute(
            `SELECT * FROM cycle_types WHERE cycle_id = ?`,
            [activeCycle.id]
          );

          for (const type of types) {
            await db.execute(
              `INSERT INTO contributions 
               (member_id, cycle_id, type_id, amount, expected_amount,
                payment_method, recorded_by, status, notes)
               VALUES (?, ?, ?, ?, ?, 'balance', ?, 'paid', 'Paid from member balance')`,
              [
                member.id,
                activeCycle.id,
                type.type_id,
                type.amount,
                type.amount,
                req.user.id
              ]
            );
          }

          results.processed++;
          results.details.push({
            member_id: member.id,
            member_name: member.name,
            status: 'paid_from_balance',
            amount: remainingToPay,
            new_balance: member.contribution_balance - remainingToPay
          });
        } else {
          // Not enough balance, mark as pending/partial based on existing contributions
          results.skipped++;
          results.details.push({
            member_id: member.id,
            member_name: member.name,
            status: 'pending',
            amount_due: remainingToPay,
            current_balance: member.contribution_balance,
            reason: 'Insufficient balance'
          });
        }
      } catch (error) {
        console.error(`Error processing member ${member.id}:`, error);
        results.failed++;
        results.details.push({
          member_id: member.id,
          member_name: member.name,
          status: 'failed',
          error: error.message
        });
      }
    }

    // Update cycle collected amount
    const totalCollected = results.details
      .filter(d => d.status === 'paid_from_balance')
      .reduce((sum, d) => sum + (d.amount || 0), 0);

    if (totalCollected > 0) {
      await db.execute(
        `UPDATE contribution_cycles 
         SET collected_amount = collected_amount + ?
         WHERE id = ?`,
        [totalCollected, activeCycle.id]
      );
    }

    res.json({
      success: true,
      message: 'Scheduled contributions processed',
      data: {
        cycle: activeCycle,
        summary: results,
        total_collected: totalCollected
      }
    });

  } catch (error) {
    console.error('❌ Process scheduled error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error processing scheduled contributions'
    });
  }
};

/**
 * @desc    Record bulk contributions
 * @route   POST /api/contributions/bulk
 * @access  Private (Admin only)
 */
const recordBulkContributions = async (req, res) => {
  const { chamaId, contributions: bulkContributions, notes } = req.body;

  try {
    if (!chamaId || !bulkContributions || !Array.isArray(bulkContributions)) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: chamaId and contributions array'
      });
    }

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [chamaId, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Get active cycle
    const [activeCycles] = await db.execute(
      `SELECT id, cycle_number FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC LIMIT 1`,
      [chamaId]
    );

    if (activeCycles.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active cycle found'
      });
    }

    const activeCycleId = activeCycles[0].id;
    const cycleNumber = activeCycles[0].cycle_number;

    const results = {
      total: bulkContributions.length,
      successful: 0,
      failed: 0,
      details: []
    };

    // Process each contribution
    for (const contribution of bulkContributions) {
      try {
        const { memberId, amount, paymentMethod = 'cash', paymentReference, memberNotes } = contribution;

        if (!memberId || !amount) {
          results.failed++;
          results.details.push({
            memberId,
            status: 'failed',
            error: 'Missing memberId or amount'
          });
          continue;
        }

        // Check if member exists in chama
        const [memberCheck] = await db.execute(
          `SELECT id FROM members 
           WHERE chama_id = ? AND id = ?`,
          [chamaId, memberId]
        );

        if (memberCheck.length === 0) {
          results.failed++;
          results.details.push({
            memberId,
            status: 'failed',
            error: 'Member not found in chama'
          });
          continue;
        }

        // Record contribution
        const [result] = await db.execute(
          `INSERT INTO contributions 
           (member_id, cycle_id, amount, expected_amount,
            payment_method, payment_reference, notes, recorded_by, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid')`,
          [
            memberId,
            activeCycleId,
            amount,
            amount, // For bulk, expected = paid amount
            paymentMethod,
            paymentReference || null,
            `${notes || 'Bulk import'}${memberNotes ? ` - ${memberNotes}` : ''}`,
            req.user.id
          ]
        );

        // Update member balance
        await updateMemberBalance(
          memberId,
          amount,
          `Bulk contribution for cycle ${cycleNumber}`,
          req.user.id,
          activeCycleId,
          result.insertId
        );

        // Update cycle collected amount
        await db.execute(
          `UPDATE contribution_cycles 
           SET collected_amount = collected_amount + ?
           WHERE id = ?`,
          [amount, activeCycleId]
        );

        results.successful++;
        results.details.push({
          memberId,
          contributionId: result.insertId,
          status: 'success',
          amount
        });

      } catch (error) {
        console.error(`Error processing bulk contribution for member ${contribution.memberId}:`, error);
        results.failed++;
        results.details.push({
          memberId: contribution.memberId,
          status: 'failed',
          error: error.message
        });
      }
    }

    // Record bulk transaction
    const totalAmount = results.details
      .filter(d => d.status === 'success')
      .reduce((sum, d) => sum + (d.amount || 0), 0);

    if (totalAmount > 0) {
      await db.execute(
        `INSERT INTO transactions 
         (chama_id, transaction_type, amount, description, created_by) 
         VALUES (?, 'bulk_contribution', ?, ?, ?)`,
        [
          chamaId,
          totalAmount,
          `Bulk contributions recorded: ${results.successful} transactions`,
          req.user.id
        ]
      );
    }

    res.status(201).json({
      success: true,
      message: 'Bulk contributions recorded',
      data: {
        cycle: {
          id: activeCycleId,
          cycle_number: cycleNumber
        },
        summary: results,
        total_amount: totalAmount
      }
    });

  } catch (error) {
    console.error('❌ Record bulk contributions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error recording bulk contributions'
    });
  }
};

// ============================================
// DASHBOARD & ANALYTICS CONTROLLERS
// ============================================

/**
 * @desc    Get contribution dashboard
 * @route   GET /api/contributions/dashboard/:chamaId
 * @access  Private (Members)
 */
const getContributionDashboard = async (req, res) => {
  try {
    const { chamaId } = req.params;

    // Check membership
    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }

    const isAdmin = membership[0].role === 'admin';

    // Get active cycle
    const [activeCycles] = await db.execute(
      `SELECT cc.*, 
              COUNT(DISTINCT c.member_id) as paid_members,
              COUNT(DISTINCT m.id) as total_members,
              SUM(c.amount) as total_collected
       FROM contribution_cycles cc
       LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.status = 'paid'
       LEFT JOIN members m ON cc.chama_id = m.chama_id
       WHERE cc.chama_id = ? AND cc.status = 'active'
       GROUP BY cc.id
       ORDER BY cc.cycle_number DESC
       LIMIT 1`,
      [chamaId]
    );

    const activeCycle = activeCycles[0];

    // Get member's personal status if not admin
    let personalStatus = null;
    if (!isAdmin) {
      const [member] = await db.execute(
        'SELECT id FROM members WHERE chama_id = ? AND user_id = ?',
        [chamaId, req.user.id]
      );

      if (member.length > 0 && activeCycle) {
        const [contributions] = await db.execute(
          `SELECT c.*, ct.name as type_name
           FROM contributions c
           LEFT JOIN contribution_types ct ON c.type_id = ct.id
           WHERE c.member_id = ? AND c.cycle_id = ?`,
          [member[0].id, activeCycle.id]
        );

        const [cycleTypes] = await db.execute(
          `SELECT SUM(amount) as total_expected 
           FROM cycle_types 
           WHERE cycle_id = ?`,
          [activeCycle.id]
        );

        const totalExpected = cycleTypes[0]?.total_expected || 0;
        const totalPaid = contributions
          .filter(c => c.status === 'paid')
          .reduce((sum, c) => sum + parseFloat(c.amount), 0);
        const totalOutstanding = Math.max(0, totalExpected - totalPaid);

        personalStatus = {
          total_expected: totalExpected,
          total_paid: totalPaid,
          total_outstanding: totalOutstanding,
          payment_status: totalOutstanding === 0 ? 'paid' : (totalPaid > 0 ? 'partial' : 'pending'),
          is_overdue: new Date(activeCycle.due_date) < new Date() && totalOutstanding > 0,
          contributions: contributions
        };
      }
    }

    // Get recent contributions
    const [recentContributions] = await db.execute(
      `SELECT c.*, u.name as member_name, ct.name as type_name,
              cy.cycle_number, cy.cycle_name
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       JOIN users u ON m.user_id = u.id
       JOIN contribution_cycles cy ON c.cycle_id = cy.id
       LEFT JOIN contribution_types ct ON c.type_id = ct.id
       WHERE m.chama_id = ?
       ORDER BY c.payment_date DESC
       LIMIT 10`,
      [chamaId]
    );

    // Get upcoming cycles
    const [upcomingCycles] = await db.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'upcoming'
       ORDER BY cycle_number ASC
       LIMIT 3`,
      [chamaId]
    );

    // Get summary statistics
    const [summary] = await db.execute(
      `SELECT 
         COUNT(DISTINCT c.id) as total_contributions,
         SUM(c.amount) as total_collected,
         COUNT(DISTINCT c.member_id) as active_contributors,
         AVG(c.amount) as average_contribution,
         MAX(c.payment_date) as last_contribution
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE m.chama_id = ? AND c.status = 'paid'
         AND c.payment_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      [chamaId]
    );

    // Get member balances summary (admin only)
    let balanceSummary = null;
    if (isAdmin) {
      const [balances] = await db.execute(
        `SELECT 
           SUM(CASE WHEN contribution_balance < 0 THEN 1 ELSE 0 END) as members_in_arrears,
           SUM(CASE WHEN contribution_balance > 0 THEN 1 ELSE 0 END) as members_with_credit,
           SUM(CASE WHEN contribution_balance < 0 THEN contribution_balance ELSE 0 END) as total_arrears,
           SUM(CASE WHEN contribution_balance > 0 THEN contribution_balance ELSE 0 END) as total_credit
         FROM members
         WHERE chama_id = ? AND status = 'active'`,
        [chamaId]
      );
      balanceSummary = balances[0];
    }

    res.json({
      success: true,
      data: {
        active_cycle: activeCycle,
        personal_status: personalStatus,
        recent_contributions: recentContributions,
        upcoming_cycles: upcomingCycles,
        summary: summary[0],
        balance_summary: balanceSummary,
        user_role: membership[0].role
      }
    });
  } catch (error) {
    console.error('❌ Get dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching dashboard'
    });
  }
};

/**
 * @desc    Get contribution analytics
 * @route   GET /api/contributions/analytics/:chamaId
 * @access  Private (Admin only)
 */
const getContributionAnalytics = async (req, res) => {
  try {
    const { chamaId } = req.params;
    const { period = 'month' } = req.query; // month, quarter, year

    // Check admin permission
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [chamaId, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Determine date range based on period
    let dateFormat, interval;
    switch (period) {
      case 'quarter':
        dateFormat = '%Y-%m';
        interval = 'QUARTER';
        break;
      case 'year':
        dateFormat = '%Y';
        interval = 'YEAR';
        break;
      default: // month
        dateFormat = '%Y-%m';
        interval = 'MONTH';
    }

    // Get contribution trends
    const [trends] = await db.execute(
      `SELECT 
         DATE_FORMAT(c.payment_date, ?) as period,
         COUNT(*) as contribution_count,
         SUM(c.amount) as total_amount,
         COUNT(DISTINCT c.member_id) as unique_members,
         AVG(c.amount) as average_amount
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE m.chama_id = ? AND c.status = 'paid'
         AND c.payment_date >= DATE_SUB(NOW(), INTERVAL 12 ${interval})
       GROUP BY DATE_FORMAT(c.payment_date, ?)
       ORDER BY period DESC`,
      [dateFormat, chamaId, dateFormat]
    );

    // Get member performance
    const [memberPerformance] = await db.execute(
      `SELECT 
         m.id,
         u.name,
         COUNT(c.id) as contribution_count,
         SUM(c.amount) as total_contributed,
         AVG(c.amount) as average_contribution,
         MIN(c.payment_date) as first_contribution,
         MAX(c.payment_date) as last_contribution,
         m.contribution_balance,
         CASE 
           WHEN m.contribution_balance >= 0 THEN 'good'
           WHEN m.contribution_balance >= -1000 THEN 'warning'
           ELSE 'critical'
         END as status
       FROM members m
       JOIN users u ON m.user_id = u.id
       LEFT JOIN contributions c ON m.id = c.member_id AND c.status = 'paid'
       WHERE m.chama_id = ? AND m.status = 'active'
       GROUP BY m.id
       ORDER BY total_contributed DESC
       LIMIT 20`,
      [chamaId]
    );

    // Get cycle performance
    const [cyclePerformance] = await db.execute(
      `SELECT 
         cc.id,
         cc.cycle_number,
         cc.cycle_name,
         cc.cycle_date,
         cc.due_date,
         cc.status,
         COUNT(DISTINCT c.member_id) as members_paid,
         COUNT(DISTINCT m.id) as total_members,
         SUM(c.amount) as total_collected,
         (SELECT SUM(amount) FROM cycle_types WHERE cycle_id = cc.id) as total_expected,
         ROUND((COUNT(DISTINCT c.member_id) / COUNT(DISTINCT m.id)) * 100, 2) as compliance_rate
       FROM contribution_cycles cc
       LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.status = 'paid'
       LEFT JOIN members m ON cc.chama_id = m.chama_id
       WHERE cc.chama_id = ?
       GROUP BY cc.id
       ORDER BY cc.cycle_number DESC
       LIMIT 10`,
      [chamaId]
    );

    // Get payment method distribution
    const [paymentDistribution] = await db.execute(
      `SELECT 
         c.payment_method,
         COUNT(*) as transaction_count,
         SUM(c.amount) as total_amount,
         ROUND((COUNT(*) / (SELECT COUNT(*) FROM contributions c2 JOIN members m2 ON c2.member_id = m2.id WHERE m2.chama_id = ? AND c2.status = 'paid')) * 100, 2) as percentage
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE m.chama_id = ? AND c.status = 'paid'
       GROUP BY c.payment_method
       ORDER BY total_amount DESC`,
      [chamaId, chamaId]
    );

    // Get arrears analysis
    const [arrearsAnalysis] = await db.execute(
      `SELECT 
         CASE 
           WHEN contribution_balance >= 0 THEN '0. No Arrears'
           WHEN contribution_balance >= -1000 THEN '1. Small Arrears (< 1K)'
           WHEN contribution_balance >= -5000 THEN '2. Medium Arrears (1K-5K)'
           ELSE '3. Large Arrears (> 5K)'
         END as arrears_category,
         COUNT(*) as member_count,
         SUM(contribution_balance) as total_arrears,
         ROUND((COUNT(*) / (SELECT COUNT(*) FROM members WHERE chama_id = ? AND status = 'active')) * 100, 2) as percentage
       FROM members
       WHERE chama_id = ? AND status = 'active' AND contribution_balance < 0
       GROUP BY arrears_category
       ORDER BY arrears_category`,
      [chamaId, chamaId]
    );

    // Get prediction for next cycle
    const [prediction] = await db.execute(
      `SELECT 
         ROUND(AVG(total_collected), 2) as predicted_amount,
         ROUND(AVG(compliance_rate), 2) as predicted_compliance
       FROM (
         SELECT 
           cc.id,
           SUM(c.amount) as total_collected,
           (COUNT(DISTINCT c.member_id) / COUNT(DISTINCT m.id)) * 100 as compliance_rate
         FROM contribution_cycles cc
         LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.status = 'paid'
         LEFT JOIN members m ON cc.chama_id = m.chama_id
         WHERE cc.chama_id = ? AND cc.status = 'completed'
         GROUP BY cc.id
         ORDER BY cc.cycle_number DESC
         LIMIT 3
       ) as recent_cycles`,
      [chamaId]
    );

    res.json({
      success: true,
      data: {
        trends: trends,
        member_performance: memberPerformance,
        cycle_performance: cyclePerformance,
        payment_distribution: paymentDistribution,
        arrears_analysis: arrearsAnalysis,
        predictions: prediction[0],
        period: period,
        generated_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Get analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching analytics'
    });
  }
};

// ============================================
// EXPORT ALL CONTROLLERS
// ============================================

module.exports = {
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
};