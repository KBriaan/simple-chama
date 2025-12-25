const db = require('../config/database');

// @desc    Create a payout (rotating savings)
// @route   POST /api/payouts
// @access  Private (Admin only)
const createPayout = async (req, res) => {
  const { chamaId, memberId, amount, payoutDate, notes } = req.body;

  try {
    // Validate
    if (!chamaId || !memberId || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Please provide chamaId, memberId, and amount'
      });
    }

    // Check if user is admin
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

    // Get current active cycle
    const [cycles] = await db.execute(
      `SELECT id, cycle_number FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC
       LIMIT 1`,
      [chamaId]
    );

    if (cycles.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active contribution cycle found'
      });
    }

    const cycleId = cycles[0].id;

    // Check if member has already received payout this cycle
    const [existingPayout] = await db.execute(
      `SELECT id FROM payouts 
       WHERE chama_id = ? AND member_id = ? AND cycle_id = ?`,
      [chamaId, memberId, cycleId]
    );

    if (existingPayout.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Member has already received a payout this cycle'
      });
    }

    // Check chama balance
    const [balanceResult] = await db.execute(
      `SELECT 
         COALESCE(SUM(c.amount), 0) as total_contributions,
         COALESCE(SUM(p.amount), 0) as total_payouts
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       LEFT JOIN payouts p ON p.chama_id = m.chama_id AND p.status = 'paid'
       WHERE m.chama_id = ? AND c.status = 'paid'`,
      [chamaId]
    );

    const availableBalance = (balanceResult[0].total_contributions || 0) - (balanceResult[0].total_payouts || 0);

    if (availableBalance < amount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient chama balance. Available: ${availableBalance}`
      });
    }

    // Start transaction
    await db.execute('START TRANSACTION');

    try {
      // Create payout
      const [payoutResult] = await db.execute(
        `INSERT INTO payouts 
         (chama_id, member_id, cycle_id, amount, payout_date, status, notes) 
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [
          chamaId,
          memberId,
          cycleId,
          amount,
          payoutDate || new Date().toISOString().split('T')[0],
          notes || null
        ]
      );

      // Record transaction
      await db.execute(
        `INSERT INTO transactions 
         (chama_id, transaction_type, amount, description, created_by) 
         VALUES (?, 'payout', ?, ?, ?)`,
        [
          chamaId,
          amount,
          `Payout created for member ID: ${memberId}`,
          req.user.id
        ]
      );

      await db.execute('COMMIT');

      // Get payout details
      const [payouts] = await db.execute(
        `SELECT p.*, u.name as member_name, cy.cycle_number
         FROM payouts p
         JOIN members m ON p.member_id = m.id
         JOIN users u ON m.user_id = u.id
         JOIN contribution_cycles cy ON p.cycle_id = cy.id
         WHERE p.id = ?`,
        [payoutResult.insertId]
      );

      res.status(201).json({
        success: true,
        message: 'Payout created successfully',
        data: payouts[0]
      });
    } catch (error) {
      await db.execute('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Create payout error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating payout'
    });
  }
};

// @desc    Update payout status (mark as paid)
// @route   PUT /api/payouts/:id/status
// @access  Private (Admin only)
const updatePayoutStatus = async (req, res) => {
  const { status } = req.body;

  try {
    // Get payout details
    const [payouts] = await db.execute(
      `SELECT p.*, m.chama_id, m.user_id as member_user_id
       FROM payouts p
       JOIN members m ON p.member_id = m.id
       WHERE p.id = ?`,
      [req.params.id]
    );

    if (payouts.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payout not found'
      });
    }

    const payout = payouts[0];

    // Check if user is admin
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [payout.chama_id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Update status
    await db.execute(
      'UPDATE payouts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, req.params.id]
    );

    // If marking as paid, update transaction
    if (status === 'paid') {
      await db.execute(
        `INSERT INTO transactions 
         (chama_id, transaction_type, amount, description, created_by) 
         VALUES (?, 'payout', ?, ?, ?)`,
        [
          payout.chama_id,
          payout.amount,
          `Payout marked as paid for member ID: ${payout.member_id}`,
          req.user.id
        ]
      );
    }

    res.json({
      success: true,
      message: 'Payout status updated successfully'
    });
  } catch (error) {
    console.error('Update payout status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating payout status'
    });
  }
};

// @desc    Get payouts for a chama
// @route   GET /api/payouts/chama/:chamaId
// @access  Private (Members only)
const getChamaPayouts = async (req, res) => {
  try {
    // Check if user is a member
    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view payouts for this chama'
      });
    }

    const { cycleId, memberId, status, startDate, endDate } = req.query;
    
    let query = `
      SELECT p.*, u.name as member_name, u.phone as member_phone,
             cy.cycle_number, cy.cycle_date,
             m.role as member_role
      FROM payouts p
      JOIN members m ON p.member_id = m.id
      JOIN users u ON m.user_id = u.id
      JOIN contribution_cycles cy ON p.cycle_id = cy.id
      WHERE p.chama_id = ?
    `;
    
    const params = [req.params.chamaId];

    if (cycleId) {
      query += ' AND p.cycle_id = ?';
      params.push(cycleId);
    }

    if (memberId) {
      query += ' AND p.member_id = ?';
      params.push(memberId);
    }

    if (status) {
      query += ' AND p.status = ?';
      params.push(status);
    }

    if (startDate) {
      query += ' AND DATE(p.payout_date) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(p.payout_date) <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY p.payout_date DESC';

    const [payouts] = await db.execute(query, params);

    // Get summary
    const [summary] = await db.execute(
      `SELECT 
         COUNT(*) as total_payouts,
         SUM(amount) as total_amount,
         COUNT(DISTINCT member_id) as unique_members
       FROM payouts 
       WHERE chama_id = ? AND status = 'paid'
       ${cycleId ? ' AND cycle_id = ?' : ''}`,
      cycleId ? [req.params.chamaId, cycleId] : [req.params.chamaId]
    );

    res.json({
      success: true,
      count: payouts.length,
      summary: summary[0],
      data: payouts
    });
  } catch (error) {
    console.error('Get payouts error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching payouts'
    });
  }
};

// @desc    Get member payouts
// @route   GET /api/payouts/member/:memberId
// @access  Private (Self or Admin)
const getMemberPayouts = async (req, res) => {
  try {
    // Get member details
    const [members] = await db.execute(
      `SELECT m.*, u.name, u.phone, c.name as chama_name
       FROM members m
       JOIN users u ON m.user_id = u.id
       JOIN chamas c ON m.chama_id = c.id
       WHERE m.id = ?`,
      [req.params.memberId]
    );

    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    const member = members[0];

    // Check permission
    const [permission] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ?`,
      [member.chama_id, req.user.id]
    );

    if (permission.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view these payouts'
      });
    }

    const isAdmin = permission[0].role === 'admin';
    const isSelf = member.user_id === req.user.id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view these payouts'
      });
    }

    // Get payouts
    const [payouts] = await db.execute(
      `SELECT p.*, cy.cycle_number, cy.cycle_date
       FROM payouts p
       JOIN contribution_cycles cy ON p.cycle_id = cy.id
       WHERE p.member_id = ?
       ORDER BY p.payout_date DESC`,
      [req.params.memberId]
    );

    // Get summary
    const [summary] = await db.execute(
      `SELECT 
         COUNT(*) as total_payouts,
         SUM(amount) as total_amount
       FROM payouts 
       WHERE member_id = ? AND status = 'paid'`,
      [req.params.memberId]
    );

    res.json({
      success: true,
      member: {
        id: member.id,
        name: member.name,
        phone: member.phone,
        chamaName: member.chama_name,
        role: member.role
      },
      summary: summary[0],
      data: payouts
    });
  } catch (error) {
    console.error('Get member payouts error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching member payouts'
    });
  }
};

// @desc    Get next member for payout (rotating logic)
// @route   GET /api/payouts/next/:chamaId
// @access  Private (Admin only)
const getNextPayoutMember = async (req, res) => {
  try {
    // Check if user is admin
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [req.params.chamaId, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Get all members who haven't received payout in current cycle
    const [members] = await db.execute(
      `SELECT m.id as member_id, u.name, u.phone,
              COUNT(DISTINCT p.id) as total_payouts_received,
              MAX(p.payout_date) as last_payout_date
       FROM members m
       JOIN users u ON m.user_id = u.id
       LEFT JOIN payouts p ON m.id = p.member_id AND p.status = 'paid'
       WHERE m.chama_id = ?
       AND m.id NOT IN (
         SELECT member_id FROM payouts 
         WHERE chama_id = ? AND cycle_id IN (
           SELECT id FROM contribution_cycles 
           WHERE chama_id = ? AND status = 'active'
         )
       )
       GROUP BY m.id, u.name, u.phone
       ORDER BY 
         total_payouts_received ASC,
         last_payout_date ASC NULLS FIRST,
         m.joined_at ASC
       LIMIT 1`,
      [req.params.chamaId, req.params.chamaId, req.params.chamaId]
    );

    if (members.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No members available for payout this cycle'
      });
    }

    // Get chama contribution amount
    const [chama] = await db.execute(
      'SELECT contribution_amount FROM chamas WHERE id = ?',
      [req.params.chamaId]
    );

    res.json({
      success: true,
      data: {
        member: members[0],
        suggestedAmount: chama[0].contribution_amount,
        note: 'This member has the fewest payouts and/or longest time since last payout'
      }
    });
  } catch (error) {
    console.error('Get next payout member error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error determining next payout member'
    });
  }
};

module.exports = {
  createPayout,
  updatePayoutStatus,
  getChamaPayouts,
  getMemberPayouts,
  getNextPayoutMember
};