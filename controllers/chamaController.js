const db = require('../config/database');

// @desc    Create a chama
// @route   POST /api/chamas
// @access  Private
const createChama = async (req, res) => {
  const { 
    name, 
    description, 
    contributionAmount, 
    contributionCycle,
    meetingSchedule 
  } = req.body;

  console.log('Creating chama with data:', req.body);
  console.log('User ID:', req.user?.id);

  try {
    // Validate
    if (!name || !contributionAmount) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name and contribution amount'
      });
    }

    // Create chama without transaction for now
    const [chamaResult] = await db.execute(
      `INSERT INTO chamas 
       (name, description, contribution_amount, contribution_cycle, meeting_schedule, created_by) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        name,
        description || null,
        contributionAmount,
        contributionCycle || 'monthly',
        meetingSchedule || null,
        req.user.id
      ]
    );

    console.log('Chama created with ID:', chamaResult.insertId);

    // Add creator as admin member
    await db.execute(
      `INSERT INTO members (user_id, chama_id, role) 
       VALUES (?, ?, 'admin')`,
      [req.user.id, chamaResult.insertId]
    );

    console.log('Admin member added');

    // Create first contribution cycle
    const today = new Date();
    const dueDate = new Date(today);
    dueDate.setMonth(dueDate.getMonth() + 1);

    await db.execute(
      `INSERT INTO contribution_cycles 
       (chama_id, cycle_number, cycle_date, due_date, status) 
       VALUES (?, 1, ?, ?, 'active')`,
      [
        chamaResult.insertId,
        today.toISOString().split('T')[0],
        dueDate.toISOString().split('T')[0]
      ]
    );

    console.log('Contribution cycle created');

    // Get created chama
    const [chamas] = await db.execute(
      `SELECT c.*, u.name as creator_name 
       FROM chamas c
       JOIN users u ON c.created_by = u.id
       WHERE c.id = ?`,
      [chamaResult.insertId]
    );

    console.log('Chama fetch successful');

    res.status(201).json({
      success: true,
      message: 'Chama created successfully',
      data: chamas[0]
    });
  } catch (error) {
    console.error('Create chama error details:', error);
    console.error('Error SQL:', error.sql);
    console.error('Error parameters:', error.parameters);
    
    res.status(500).json({
      success: false,
      message: 'Server error creating chama',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// @desc    Get all chamas for current user
// @route   GET /api/chamas
// @access  Private
const getMyChamas = async (req, res) => {
  try {
    console.log('Getting chamas for user ID:', req.user.id);
    
    const [chamas] = await db.execute(
      `SELECT c.*, m.role 
       FROM chamas c
       JOIN members m ON c.id = m.chama_id
       WHERE m.user_id = ?
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );

    console.log(`Found ${chamas.length} chamas`);

    // Get member counts for each chama
    for (let chama of chamas) {
      const [memberCount] = await db.execute(
        'SELECT COUNT(*) as count FROM members WHERE chama_id = ?',
        [chama.id]
      );
      chama.memberCount = memberCount[0].count;
    }

    res.json({
      success: true,
      count: chamas.length,
      data: chamas
    });
  } catch (error) {
    console.error('Get chamas error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching chamas'
    });
  }
};

// @desc    Get single chama
// @route   GET /api/chamas/:id
// @access  Private
const getChama = async (req, res) => {
  try {
    console.log('Getting chama ID:', req.params.id, 'for user:', req.user.id);
    
    const [chamas] = await db.execute(
      `SELECT c.*, u.name as creator_name 
       FROM chamas c
       JOIN users u ON c.created_by = u.id
       WHERE c.id = ?`,
      [req.params.id]
    );

    if (chamas.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Chama not found'
      });
    }

    // Check if user is a member
    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this chama'
      });
    }

    // Get members
    const [members] = await db.execute(
      `SELECT u.id, u.name, u.phone, u.email, m.role, m.joined_at
       FROM members m
       JOIN users u ON m.user_id = u.id
       WHERE m.chama_id = ?
       ORDER BY m.role DESC, m.joined_at`,
      [req.params.id]
    );

    // Get current cycle
    const [cycles] = await db.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC
       LIMIT 1`,
      [req.params.id]
    );

    // Get total contributions
    const [totalResult] = await db.execute(
      `SELECT SUM(amount) as total FROM contributions 
       WHERE member_id IN (
         SELECT id FROM members WHERE chama_id = ?
       ) AND status = 'paid'`,
      [req.params.id]
    );

    const chama = {
      ...chamas[0],
      members,
      currentCycle: cycles.length > 0 ? cycles[0] : null,
      totalContributions: totalResult[0].total || 0,
      userRole: membership[0].role
    };

    res.json({
      success: true,
      data: chama
    });
  } catch (error) {
    console.error('Get chama error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching chama'
    });
  }
};

// @desc    Update chama
// @route   PUT /api/chamas/:id
// @access  Private (Admin only)
const updateChama = async (req, res) => {
  try {
    // Check if user is admin
    const [membership] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [req.params.id, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    const { name, description, contributionAmount, contributionCycle, meetingSchedule } = req.body;
    
    console.log('Updating chama:', req.params.id, 'with data:', req.body);
    
    const updateFields = [];
    const values = [];

    if (name) {
      updateFields.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updateFields.push('description = ?');
      values.push(description);
    }
    if (contributionAmount) {
      updateFields.push('contribution_amount = ?');
      values.push(contributionAmount);
    }
    if (contributionCycle) {
      updateFields.push('contribution_cycle = ?');
      values.push(contributionCycle);
    }
    if (meetingSchedule !== undefined) {
      updateFields.push('meeting_schedule = ?');
      values.push(meetingSchedule);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    values.push(req.params.id);

    const query = `UPDATE chamas SET ${updateFields.join(', ')} WHERE id = ?`;
    await db.execute(query, values);

    res.json({
      success: true,
      message: 'Chama updated successfully'
    });
  } catch (error) {
    console.error('Update chama error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating chama'
    });
  }
};

// @desc    Add member to chama
// @route   POST /api/chamas/:id/members
// @access  Private (Admin only)
const addMember = async (req, res) => {
  const { phone, role = 'member' } = req.body;

  try {
    console.log('Adding member to chama:', req.params.id, 'phone:', phone);
    
    // Check if user is admin
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [req.params.id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Find user by phone
    const [users] = await db.execute(
      'SELECT id FROM users WHERE phone = ?',
      [phone]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found with this phone number'
      });
    }

    const userId = users[0].id;

    // Check if already a member
    const [existingMember] = await db.execute(
      'SELECT id FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.id, userId]
    );

    if (existingMember.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'User is already a member of this chama'
      });
    }

    // Add as member
    await db.execute(
      'INSERT INTO members (user_id, chama_id, role) VALUES (?, ?, ?)',
      [userId, req.params.id, role]
    );

    // Get member details
    const [newMember] = await db.execute(
      `SELECT u.id, u.name, u.phone, u.email, m.role, m.joined_at
       FROM members m
       JOIN users u ON m.user_id = u.id
       WHERE m.chama_id = ? AND m.user_id = ?`,
      [req.params.id, userId]
    );

    res.status(201).json({
      success: true,
      message: 'Member added successfully',
      data: newMember[0]
    });
  } catch (error) {
    console.error('Add member error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error adding member'
    });
  }
};

// @desc    Remove member from chama
// @route   DELETE /api/chamas/:id/members/:memberId
// @access  Private (Admin only)
const removeMember = async (req, res) => {
  try {
    // Check if user is admin
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [req.params.id, req.user.id]
    );

    if (adminCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Cannot remove self
    const [memberToRemove] = await db.execute(
      'SELECT user_id FROM members WHERE id = ?',
      [req.params.memberId]
    );

    if (memberToRemove.length > 0 && memberToRemove[0].user_id === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove yourself from chama'
      });
    }

    // Remove member
    await db.execute(
      'DELETE FROM members WHERE id = ? AND chama_id = ?',
      [req.params.memberId, req.params.id]
    );

    res.json({
      success: true,
      message: 'Member removed successfully'
    });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error removing member'
    });
  }
};

// @desc    Get chama statistics
// @route   GET /api/chamas/:id/stats
// @access  Private (Members only)
const getChamaStats = async (req, res) => {
  try {
    // Check if user is a member
    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view chama stats'
      });
    }

    // Get total contributions
    const [totalResult] = await db.execute(
      `SELECT SUM(amount) as total FROM contributions 
       WHERE member_id IN (
         SELECT id FROM members WHERE chama_id = ?
       ) AND status = 'paid'`,
      [req.params.id]
    );

    // Get total payouts
    const [payoutResult] = await db.execute(
      `SELECT SUM(amount) as total FROM payouts 
       WHERE chama_id = ? AND status = 'paid'`,
      [req.params.id]
    );

    // Get member count
    const [memberCount] = await db.execute(
      'SELECT COUNT(*) as count FROM members WHERE chama_id = ?',
      [req.params.id]
    );

    // Get current cycle
    const [currentCycle] = await db.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC
       LIMIT 1`,
      [req.params.id]
    );

    // Get contributions for current cycle
    let currentCycleContributions = 0;
    if (currentCycle.length > 0) {
      const [cycleContributions] = await db.execute(
        `SELECT COUNT(DISTINCT member_id) as paid_count 
         FROM contributions 
         WHERE cycle_id = ? AND status = 'paid'`,
        [currentCycle[0].id]
      );
      currentCycleContributions = cycleContributions[0].paid_count;
    }

    res.json({
      success: true,
      data: {
        totalContributions: totalResult[0].total || 0,
        totalPayouts: payoutResult[0].total || 0,
        currentBalance: (totalResult[0].total || 0) - (payoutResult[0].total || 0),
        memberCount: memberCount[0].count,
        currentCycle: currentCycle.length > 0 ? currentCycle[0] : null,
        paidThisCycle: currentCycleContributions,
        paymentRate: memberCount[0].count > 0 ? 
          (currentCycleContributions / memberCount[0].count) * 100 : 0
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching statistics'
    });
  }
};

module.exports = {
  createChama,
  getMyChamas,
  getChama,
  updateChama,
  addMember,
  removeMember,
  getChamaStats
};