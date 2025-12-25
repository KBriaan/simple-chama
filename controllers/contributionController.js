const db = require('../config/database');

// @desc    Record contribution
// @route   POST /api/contributions
// @access  Private
const recordContribution = async (req, res) => {
  const { chamaId, memberId, amount, paymentMethod, notes } = req.body;

  console.log('💰 Recording contribution:', { chamaId, memberId, amount, user: req.user.id });

  try {
    // Validate
    if (!chamaId || !memberId || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Please provide chamaId, memberId, and amount'
      });
    }

    // Check if user has permission (must be admin or the member themselves)
    const [permission] = await db.execute(
      `SELECT m.role, m.id as membership_id 
       FROM members m
       WHERE m.chama_id = ? AND m.user_id = ?`,
      [chamaId, req.user.id]
    );

    if (permission.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to record contributions for this chama'
      });
    }

    const isAdmin = permission[0].role === 'admin';
    const isSelf = permission[0].membership_id === parseInt(memberId);

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        success: false,
        message: 'You can only record your own contributions unless you are an admin'
      });
    }

    // Get current active cycle
    const [cycles] = await db.execute(
      `SELECT id FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC
       LIMIT 1`,
      [chamaId]
    );

    if (cycles.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active contribution cycle found for this chama'
      });
    }

    const cycleId = cycles[0].id;
    console.log('Using cycle ID:', cycleId);

    // Check if already contributed for this cycle
    const [existingContribution] = await db.execute(
      `SELECT id FROM contributions 
       WHERE member_id = ? AND cycle_id = ? AND status = 'paid'`,
      [memberId, cycleId]
    );

    if (existingContribution.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Member has already contributed for this cycle'
      });
    }

    // Record contribution
    const [result] = await db.execute(
      `INSERT INTO contributions 
       (member_id, cycle_id, amount, payment_method, notes, recorded_by, status) 
       VALUES (?, ?, ?, ?, ?, ?, 'paid')`,
      [
        memberId,
        cycleId,
        amount,
        paymentMethod || null,
        notes || null,
        req.user.id
      ]
    );

    console.log('Contribution recorded with ID:', result.insertId);

    // Record transaction
    await db.execute(
      `INSERT INTO transactions 
       (chama_id, transaction_type, amount, description, created_by) 
       VALUES (?, 'contribution', ?, ?, ?)`,
      [
        chamaId,
        amount,
        `Contribution recorded for member ID: ${memberId}`,
        req.user.id
      ]
    );

    console.log('Transaction recorded');

    // Get contribution details
    const [contributions] = await db.execute(
      `SELECT c.*, u.name as member_name, cy.cycle_number
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       JOIN users u ON m.user_id = u.id
       JOIN contribution_cycles cy ON c.cycle_id = cy.id
       WHERE c.id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: 'Contribution recorded successfully',
      data: contributions[0]
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

// @desc    Get contributions for a chama
// @route   GET /api/contributions/chama/:chamaId
// @access  Private (Members only)
const getChamaContributions = async (req, res) => {
  try {
    console.log('📊 Getting contributions for chama:', req.params.chamaId);
    
    // Check if user is a member
    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view contributions for this chama'
      });
    }

    const { cycleId, memberId, status, startDate, endDate } = req.query;
    
    let query = `
      SELECT c.*, u.name as member_name, u.phone as member_phone,
             cy.cycle_number, cy.cycle_date, cy.due_date,
             m.role as member_role
      FROM contributions c
      JOIN members m ON c.member_id = m.id
      JOIN users u ON m.user_id = u.id
      JOIN contribution_cycles cy ON c.cycle_id = cy.id
      WHERE m.chama_id = ?
    `;
    
    const params = [req.params.chamaId];

    if (cycleId) {
      query += ' AND c.cycle_id = ?';
      params.push(cycleId);
    }

    if (memberId) {
      query += ' AND c.member_id = ?';
      params.push(memberId);
    }

    if (status) {
      query += ' AND c.status = ?';
      params.push(status);
    }

    if (startDate) {
      query += ' AND DATE(c.payment_date) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(c.payment_date) <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY c.payment_date DESC';

    console.log('Executing query:', query.substring(0, 100) + '...');
    const [contributions] = await db.execute(query, params);

    // Get summary
    const [summary] = await db.execute(
      `SELECT 
         COUNT(*) as total_contributions,
         SUM(amount) as total_amount,
         COUNT(DISTINCT member_id) as unique_members
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE m.chama_id = ? AND c.status = 'paid'
       ${cycleId ? ' AND c.cycle_id = ?' : ''}`,
      cycleId ? [req.params.chamaId, cycleId] : [req.params.chamaId]
    );

    console.log(`Found ${contributions.length} contributions`);

    res.json({
      success: true,
      count: contributions.length,
      summary: summary[0],
      data: contributions
    });
  } catch (error) {
    console.error('❌ Get contributions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching contributions'
    });
  }
};

// @desc    Get member contributions
// @route   GET /api/contributions/member/:memberId
// @access  Private (Self or Admin)
const getMemberContributions = async (req, res) => {
  try {
    console.log('📊 Getting contributions for member:', req.params.memberId);
    
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
    console.log('Member found:', member.name, 'in chama:', member.chama_name);

    // Check permission (must be admin of the chama or the member themselves)
    const [permission] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ?`,
      [member.chama_id, req.user.id]
    );

    if (permission.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view these contributions'
      });
    }

    const isAdmin = permission[0].role === 'admin';
    const isSelf = member.user_id === req.user.id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view these contributions'
      });
    }

    // Get contributions
    const [contributions] = await db.execute(
      `SELECT c.*, cy.cycle_number, cy.cycle_date, cy.due_date
       FROM contributions c
       JOIN contribution_cycles cy ON c.cycle_id = cy.id
       WHERE c.member_id = ?
       ORDER BY c.payment_date DESC`,
      [req.params.memberId]
    );

    // Get summary
    const [summary] = await db.execute(
      `SELECT 
         COUNT(*) as total_contributions,
         SUM(amount) as total_amount,
         COUNT(DISTINCT cycle_id) as cycles_contributed
       FROM contributions 
       WHERE member_id = ? AND status = 'paid'`,
      [req.params.memberId]
    );

    console.log(`Found ${contributions.length} contributions for member`);

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
      data: contributions
    });
  } catch (error) {
    console.error('❌ Get member contributions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching member contributions'
    });
  }
};

// @desc    Update contribution status
// @route   PUT /api/contributions/:id/status
// @access  Private (Admin only)
const updateContributionStatus = async (req, res) => {
  const { status } = req.body;

  console.log('🔄 Updating contribution status:', req.params.id, 'to', status);

  try {
    // Get contribution details
    const [contributions] = await db.execute(
      `SELECT c.*, m.chama_id, m.user_id as member_user_id
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE c.id = ?`,
      [req.params.id]
    );

    if (contributions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contribution not found'
      });
    }

    const contribution = contributions[0];
    console.log('Contribution found for chama:', contribution.chama_id);

    // Check if user is admin of the chama
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
      [status, req.params.id]
    );

    // Record transaction if marked as paid
    if (status === 'paid') {
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

// @desc    Create new contribution cycle
// @route   POST /api/contributions/cycles
// @access  Private (Admin only)
const createContributionCycle = async (req, res) => {
  const { chamaId, cycleDate, dueDate } = req.body;

  console.log('📅 Creating new contribution cycle for chama:', chamaId);

  try {
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

    // Get last cycle number
    const [lastCycle] = await db.execute(
      `SELECT MAX(cycle_number) as last_cycle_number 
       FROM contribution_cycles 
       WHERE chama_id = ?`,
      [chamaId]
    );

    const nextCycleNumber = (lastCycle[0].last_cycle_number || 0) + 1;
    console.log('Next cycle number:', nextCycleNumber);

    // Close previous active cycle
    await db.execute(
      `UPDATE contribution_cycles 
       SET status = 'completed' 
       WHERE chama_id = ? AND status = 'active'`,
      [chamaId]
    );

    // Create new cycle
    const [result] = await db.execute(
      `INSERT INTO contribution_cycles 
       (chama_id, cycle_number, cycle_date, due_date, status) 
       VALUES (?, ?, ?, ?, 'active')`,
      [
        chamaId,
        nextCycleNumber,
        cycleDate || new Date().toISOString().split('T')[0],
        dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      ]
    );

    // Get created cycle
    const [cycles] = await db.execute(
      'SELECT * FROM contribution_cycles WHERE id = ?',
      [result.insertId]
    );

    console.log('New cycle created with ID:', result.insertId);

    res.status(201).json({
      success: true,
      message: 'Contribution cycle created successfully',
      data: cycles[0]
    });
  } catch (error) {
    console.error('❌ Create cycle error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating contribution cycle'
    });
  }
};

module.exports = {
  recordContribution,
  getChamaContributions,
  getMemberContributions,
  updateContributionStatus,
  createContributionCycle
};