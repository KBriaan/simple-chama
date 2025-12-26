const db = require('../config/database');
const axios = require('axios');
const crypto = require('crypto');
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

  let connection;
  
  try {
    // Validate
    if (!name || !contributionAmount) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name and contribution amount'
      });
    }

    // Get database connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    console.log('🔍 Starting chama creation transaction');

    // Create chama
    const [chamaResult] = await connection.execute(
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

    const chamaId = chamaResult.insertId;
    console.log('✅ Chama created with ID:', chamaId);

    // Add creator as admin member
    const [memberResult] = await connection.execute(
      `INSERT INTO members (user_id, chama_id, role) 
       VALUES (?, ?, 'admin')`,
      [req.user.id, chamaId]
    );

    const memberId = memberResult.insertId;
    console.log('✅ Admin member added with ID:', memberId);

    // Create first contribution cycle
    const today = new Date();
    const dueDate = new Date(today);
    dueDate.setMonth(dueDate.getMonth() + 1);

    const [cycleResult] = await connection.execute(
      `INSERT INTO contribution_cycles 
       (chama_id, cycle_number, cycle_date, due_date, status) 
       VALUES (?, 1, ?, ?, 'active')`,
      [
        chamaId,
        today.toISOString().split('T')[0],
        dueDate.toISOString().split('T')[0]
      ]
    );

    const cycleId = cycleResult.insertId;
    console.log('✅ Contribution cycle created with ID:', cycleId);

    // Automatically create contribution records for admin
    await connection.execute(
      `INSERT INTO contributions 
       (member_id, chama_id, cycle_id, amount, due_date, status) 
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        memberId,
        chamaId,
        cycleId,
        contributionAmount,
        dueDate.toISOString().split('T')[0]
      ]
    );

    console.log('✅ Auto-created contribution record for admin');

    // Commit transaction
    await connection.commit();

    // Get created chama with details
    const [chamas] = await db.execute(
      `SELECT c.*, u.name as creator_name 
       FROM chamas c
       JOIN users u ON c.created_by = u.id
       WHERE c.id = ?`,
      [chamaId]
    );

    console.log('✅ Chama creation completed successfully');

    res.status(201).json({
      success: true,
      message: 'Chama created successfully',
      data: chamas[0]
    });
  } catch (error) {
    console.error('❌ Create chama error:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      try {
        console.log('🔍 Rolling back transaction due to error');
        await connection.rollback();
      } catch (rollbackError) {
        console.error('❌ Rollback error:', rollbackError);
      } finally {
        connection.release();
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error creating chama',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // Always release connection if it exists
    if (connection && connection.release) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error('❌ Connection release error:', releaseError);
      }
    }
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

    // Get member counts and contribution status for each chama
    for (let chama of chamas) {
      // Get member count
      const [memberCount] = await db.execute(
        'SELECT COUNT(*) as count FROM members WHERE chama_id = ?',
        [chama.id]
      );
      chama.memberCount = memberCount[0].count;

      // Get current cycle
      const [currentCycle] = await db.execute(
        `SELECT * FROM contribution_cycles 
         WHERE chama_id = ? AND status = 'active'
         ORDER BY cycle_number DESC
         LIMIT 1`,
        [chama.id]
      );

      if (currentCycle.length > 0) {
        chama.currentCycle = currentCycle[0];
        
        // Check if user has paid for current cycle
        const [userPayment] = await db.execute(
          `SELECT c.status 
           FROM contributions c
           JOIN members m ON c.member_id = m.id
           WHERE m.user_id = ? 
           AND m.chama_id = ?
           AND c.cycle_id = ?`,
          [req.user.id, chama.id, currentCycle[0].id]
        );

        chama.userPaymentStatus = userPayment.length > 0 ? userPayment[0].status : 'pending';
      }
    }

    res.json({
      success: true,
      count: chamas.length,
      data: chamas
    });
  } catch (error) {
    console.error('❌ Get chamas error:', error);
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

    // Get members with their contribution status
    const [members] = await db.execute(
      `SELECT u.id, u.name, u.phone, u.email, m.role, m.joined_at, m.id as member_id
       FROM members m
       JOIN users u ON m.user_id = u.id
       WHERE m.chama_id = ?
       ORDER BY m.role DESC, m.joined_at`,
      [req.params.id]
    );

    // Get current active cycle
    const [currentCycle] = await db.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC
       LIMIT 1`,
      [req.params.id]
    );

    // Get contributions for current cycle
    let cycleContributions = [];
    if (currentCycle.length > 0) {
      const [contributions] = await db.execute(
        `SELECT c.*, m.user_id, u.name as member_name
         FROM contributions c
         JOIN members m ON c.member_id = m.id
         JOIN users u ON m.user_id = u.id
         WHERE c.cycle_id = ?
         ORDER BY c.paid_date DESC`,
        [currentCycle[0].id]
      );
      cycleContributions = contributions;
    }

    // Get total contributions
    const [totalResult] = await db.execute(
      `SELECT SUM(amount) as total FROM contributions 
       WHERE member_id IN (
         SELECT id FROM members WHERE chama_id = ?
       ) AND status = 'paid'`,
      [req.params.id]
    );

    // Get all cycles for this chama
    const [allCycles] = await db.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ?
       ORDER BY cycle_number DESC`,
      [req.params.id]
    );

    const chama = {
      ...chamas[0],
      members: members.map(member => ({
        ...member,
        currentCycleStatus: cycleContributions.find(c => c.user_id === member.id)?.status || 'pending'
      })),
      currentCycle: currentCycle.length > 0 ? currentCycle[0] : null,
      currentContributions: cycleContributions,
      allCycles,
      totalContributions: totalResult[0].total || 0,
      userRole: membership[0].role
    };

    res.json({
      success: true,
      data: chama
    });
  } catch (error) {
    console.error('❌ Get chama error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching chama'
    });
  }
};

// @desc    Add member to chama
// @route   POST /api/chamas/:id/members
// @access  Private (Admin only)
const addMember = async (req, res) => {
  const { phone, role = 'member' } = req.body;

  let connection;
  
  try {
    console.log('Adding member to chama:', req.params.id, 'phone:', phone);
    
    // Get database connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Check if user is admin
    const [adminCheck] = await connection.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [req.params.id, req.user.id]
    );

    if (adminCheck.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Find user by phone
    const [users] = await connection.execute(
      'SELECT id, name FROM users WHERE phone = ?',
      [phone]
    );

    if (users.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(404).json({
        success: false,
        message: 'User not found with this phone number'
      });
    }

    const userId = users[0].id;
    const userName = users[0].name;

    // Check if already a member
    const [existingMember] = await connection.execute(
      'SELECT id FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.id, userId]
    );

    if (existingMember.length > 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'User is already a member of this chama'
      });
    }

    // Add as member
    const [memberResult] = await connection.execute(
      'INSERT INTO members (user_id, chama_id, role) VALUES (?, ?, ?)',
      [userId, req.params.id, role]
    );

    const memberId = memberResult.insertId;
    console.log('✅ Member added with ID:', memberId);

    // Get current active cycle
    const [currentCycle] = await connection.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC
       LIMIT 1`,
      [req.params.id]
    );

    if (currentCycle.length > 0) {
      // Get chama contribution amount
      const [chama] = await connection.execute(
        'SELECT contribution_amount FROM chamas WHERE id = ?',
        [req.params.id]
      );

      if (chama.length > 0) {
        const contributionAmount = chama[0].contribution_amount;
        
        // Automatically create contribution record for new member
        await connection.execute(
          `INSERT INTO contributions 
           (member_id, chama_id, cycle_id, amount, due_date, status) 
           VALUES (?, ?, ?, ?, ?, 'pending')`,
          [
            memberId,
            req.params.id,
            currentCycle[0].id,
            contributionAmount,
            currentCycle[0].due_date
          ]
        );

        console.log('✅ Auto-created contribution record for new member');
      }
    }

    // Commit transaction
    await connection.commit();

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
    console.error('❌ Add member error:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('❌ Rollback error:', rollbackError);
      } finally {
        connection.release();
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error adding member'
    });
  } finally {
    // Always release connection if it exists
    if (connection && connection.release) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error('❌ Connection release error:', releaseError);
      }
    }
  }
};

// @desc    Record payment for contribution
// @route   POST /api/chamas/:id/payments
// @access  Private (Admin only)
const recordPayment = async (req, res) => {
  const { memberId, amount, paymentMethod, paymentDate, reference } = req.body;

  let connection;
  
  try {
    console.log('Recording payment for chama:', req.params.id, 'member:', memberId);
    
    // Get database connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Check if user is admin
    const [adminCheck] = await connection.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [req.params.id, req.user.id]
    );

    if (adminCheck.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Verify member belongs to chama
    const [memberCheck] = await connection.execute(
      'SELECT id, user_id FROM members WHERE id = ? AND chama_id = ?',
      [memberId, req.params.id]
    );

    if (memberCheck.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(404).json({
        success: false,
        message: 'Member not found in this chama'
      });
    }

    // Get current active cycle
    const [currentCycle] = await connection.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC
       LIMIT 1`,
      [req.params.id]
    );

    if (currentCycle.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'No active contribution cycle found'
      });
    }

    const cycleId = currentCycle[0].id;

    // Find pending contribution for this member and cycle
    const [pendingContribution] = await connection.execute(
      `SELECT id, amount FROM contributions 
       WHERE member_id = ? AND cycle_id = ? AND status = 'pending'
       ORDER BY due_date ASC
       LIMIT 1`,
      [memberId, cycleId]
    );

    let contributionId;
    
    if (pendingContribution.length === 0) {
      // No pending contribution found, create one
      const [chama] = await connection.execute(
        'SELECT contribution_amount FROM chamas WHERE id = ?',
        [req.params.id]
      );

      if (chama.length === 0) {
        await connection.rollback();
        connection.release();
        
        return res.status(404).json({
          success: false,
          message: 'Chama not found'
        });
      }

      const contributionAmount = amount || chama[0].contribution_amount;
      
      // Create new contribution record
      const [contributionResult] = await connection.execute(
        `INSERT INTO contributions 
         (member_id, chama_id, cycle_id, amount, due_date, status) 
         VALUES (?, ?, ?, ?, ?, 'paid')`,
        [
          memberId,
          req.params.id,
          cycleId,
          contributionAmount,
          new Date().toISOString().split('T')[0]
        ]
      );

      contributionId = contributionResult.insertId;
      console.log('✅ Created new contribution record:', contributionId);
    } else {
      // Update existing pending contribution
      contributionId = pendingContribution[0].id;
      
      await connection.execute(
        `UPDATE contributions 
         SET status = 'paid', 
             paid_date = ?,
             payment_method = ?,
             reference_number = ?,
             amount = COALESCE(?, amount),
             verified_by = ?
         WHERE id = ?`,
        [
          paymentDate || new Date().toISOString().split('T')[0],
          paymentMethod || 'cash',
          reference || null,
          amount || pendingContribution[0].amount,
          req.user.id,
          contributionId
        ]
      );

      console.log('✅ Updated pending contribution:', contributionId);
    }

    // Record payment transaction
    const [paymentResult] = await connection.execute(
      `INSERT INTO payments 
       (chama_id, member_id, contribution_id, amount, payment_method, 
        payment_date, reference_number, recorded_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.params.id,
        memberId,
        contributionId,
        amount || pendingContribution?.[0]?.amount || 0,
        paymentMethod || 'cash',
        paymentDate || new Date().toISOString().split('T')[0],
        reference || null,
        req.user.id
      ]
    );

    console.log('✅ Payment recorded with ID:', paymentResult.insertId);

    // Commit transaction
    await connection.commit();

    // Get updated contribution details
    const [updatedContribution] = await db.execute(
      `SELECT c.*, u.name as member_name, m.role
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       JOIN users u ON m.user_id = u.id
       WHERE c.id = ?`,
      [contributionId]
    );

    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      data: updatedContribution[0]
    });
  } catch (error) {
    console.error('❌ Record payment error:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('❌ Rollback error:', rollbackError);
      } finally {
        connection.release();
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error recording payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // Always release connection if it exists
    if (connection && connection.release) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error('❌ Connection release error:', releaseError);
      }
    }
  }
};

// @desc    Create new contribution cycle
// @route   POST /api/chamas/:id/cycles
// @access  Private (Admin only)
const createContributionCycle = async (req, res) => {
  const { dueDate } = req.body;

  let connection;
  
  try {
    console.log('Creating new contribution cycle for chama:', req.params.id);
    
    // Get database connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Check if user is admin
    const [adminCheck] = await connection.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [req.params.id, req.user.id]
    );

    if (adminCheck.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Get current cycle number
    const [lastCycle] = await connection.execute(
      `SELECT cycle_number FROM contribution_cycles 
       WHERE chama_id = ?
       ORDER BY cycle_number DESC
       LIMIT 1`,
      [req.params.id]
    );

    const nextCycleNumber = lastCycle.length > 0 ? lastCycle[0].cycle_number + 1 : 1;

    // Close previous active cycles
    await connection.execute(
      `UPDATE contribution_cycles 
       SET status = 'completed' 
       WHERE chama_id = ? AND status = 'active'`,
      [req.params.id]
    );

    // Create new cycle
    const today = new Date();
    const cycleDueDate = dueDate || new Date(today.getFullYear(), today.getMonth() + 1, 1);
    
    const [cycleResult] = await connection.execute(
      `INSERT INTO contribution_cycles 
       (chama_id, cycle_number, cycle_date, due_date, status) 
       VALUES (?, ?, ?, ?, 'active')`,
      [
        req.params.id,
        nextCycleNumber,
        today.toISOString().split('T')[0],
        cycleDueDate.toISOString().split('T')[0]
      ]
    );

    const cycleId = cycleResult.insertId;
    console.log('✅ New cycle created with ID:', cycleId);

    // Get chama contribution amount
    const [chama] = await connection.execute(
      'SELECT contribution_amount FROM chamas WHERE id = ?',
      [req.params.id]
    );

    if (chama.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(404).json({
        success: false,
        message: 'Chama not found'
      });
    }

    const contributionAmount = chama[0].contribution_amount;

    // Get all members
    const [members] = await connection.execute(
      'SELECT id FROM members WHERE chama_id = ?',
      [req.params.id]
    );

    // Automatically create contribution records for all members
    for (const member of members) {
      await connection.execute(
        `INSERT INTO contributions 
         (member_id, chama_id, cycle_id, amount, due_date, status) 
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [
          member.id,
          req.params.id,
          cycleId,
          contributionAmount,
          cycleDueDate.toISOString().split('T')[0]
        ]
      );
    }

    console.log(`✅ Auto-created contribution records for ${members.length} members`);

    // Commit transaction
    await connection.commit();

    // Get created cycle
    const [newCycle] = await db.execute(
      `SELECT * FROM contribution_cycles WHERE id = ?`,
      [cycleId]
    );

    res.status(201).json({
      success: true,
      message: `Contribution cycle created successfully for ${members.length} members`,
      data: newCycle[0]
    });
  } catch (error) {
    console.error('❌ Create cycle error:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('❌ Rollback error:', rollbackError);
      } finally {
        connection.release();
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error creating contribution cycle',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // Always release connection if it exists
    if (connection && connection.release) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error('❌ Connection release error:', releaseError);
      }
    }
  }
};

// @desc    Get chama contributions
// @route   GET /api/chamas/:id/contributions
// @access  Private (Members only)
const getContributions = async (req, res) => {
  try {
    // Check if user is a member
    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view contributions'
      });
    }

    const { cycle_id, status } = req.query;
    
    let query = `
      SELECT c.*, u.name as member_name, m.role as member_role, 
             cy.cycle_number, cy.cycle_date, cy.due_date as cycle_due_date
      FROM contributions c
      JOIN members m ON c.member_id = m.id
      JOIN users u ON m.user_id = u.id
      JOIN contribution_cycles cy ON c.cycle_id = cy.id
      WHERE c.chama_id = ?
    `;
    
    const params = [req.params.id];
    
    if (cycle_id) {
      query += ' AND c.cycle_id = ?';
      params.push(cycle_id);
    }
    
    if (status) {
      query += ' AND c.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY c.due_date ASC, u.name ASC';
    
    const [contributions] = await db.execute(query, params);

    // Group contributions by cycle
    const cycles = {};
    contributions.forEach(contribution => {
      const cycleKey = contribution.cycle_id;
      if (!cycles[cycleKey]) {
        cycles[cycleKey] = {
          cycle_id: contribution.cycle_id,
          cycle_number: contribution.cycle_number,
          cycle_date: contribution.cycle_date,
          cycle_due_date: contribution.cycle_due_date,
          contributions: []
        };
      }
      cycles[cycleKey].contributions.push(contribution);
    });

    const cyclesArray = Object.values(cycles);
    
    // Get summary statistics
    const paidCount = contributions.filter(c => c.status === 'paid').length;
    const pendingCount = contributions.filter(c => c.status === 'pending').length;
    const totalAmount = contributions
      .filter(c => c.status === 'paid')
      .reduce((sum, c) => sum + parseFloat(c.amount), 0);

    res.json({
      success: true,
      data: {
        cycles: cyclesArray,
        summary: {
          total: contributions.length,
          paid: paidCount,
          pending: pendingCount,
          totalAmount: totalAmount
        }
      }
    });
  } catch (error) {
    console.error('❌ Get contributions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching contributions'
    });
  }
};

// @desc    Get my contributions in a chama
// @route   GET /api/chamas/:id/my-contributions
// @access  Private
const getMyContributions = async (req, res) => {
  try {
    // Check if user is a member
    const [member] = await db.execute(
      'SELECT id FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (member.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not a member of this chama'
      });
    }

    const memberId = member[0].id;
    
    const [contributions] = await db.execute(
      `SELECT c.*, cy.cycle_number, cy.cycle_date, cy.due_date as cycle_due_date
       FROM contributions c
       JOIN contribution_cycles cy ON c.cycle_id = cy.id
       WHERE c.member_id = ?
       ORDER BY cy.cycle_number DESC, c.due_date DESC`,
      [memberId]
    );

    // Calculate totals
    const paidContributions = contributions.filter(c => c.status === 'paid');
    const totalPaid = paidContributions.reduce((sum, c) => sum + parseFloat(c.amount), 0);
    const pendingCount = contributions.filter(c => c.status === 'pending').length;

    res.json({
      success: true,
      data: {
        contributions,
        summary: {
          total: contributions.length,
          paid: paidContributions.length,
          pending: pendingCount,
          totalAmount: totalPaid
        }
      }
    });
  } catch (error) {
    console.error('❌ Get my contributions error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching your contributions'
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
    console.error('❌ Update chama error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating chama'
    });
  }
};

// @desc    Remove member from chama
// @route   DELETE /api/chamas/:id/members/:memberId
// @access  Private (Admin only)
const removeMember = async (req, res) => {
  let connection;
  
  try {
    // Get database connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Check if user is admin
    const [adminCheck] = await connection.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [req.params.id, req.user.id]
    );

    if (adminCheck.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin'
      });
    }

    // Cannot remove self
    const [memberToRemove] = await connection.execute(
      'SELECT user_id FROM members WHERE id = ?',
      [req.params.memberId]
    );

    if (memberToRemove.length > 0 && memberToRemove[0].user_id === req.user.id) {
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'Cannot remove yourself from chama'
      });
    }

    // Get pending contributions for this member
    const [pendingContributions] = await connection.execute(
      `SELECT id FROM contributions 
       WHERE member_id = ? 
       AND chama_id = ?
       AND status = 'pending'`,
      [req.params.memberId, req.params.id]
    );

    // Remove member (cascade should handle contributions)
    await connection.execute(
      'DELETE FROM members WHERE id = ? AND chama_id = ?',
      [req.params.memberId, req.params.id]
    );

    console.log(`✅ Member removed, also removed ${pendingContributions.length} pending contributions`);

    // Commit transaction
    await connection.commit();

    res.json({
      success: true,
      message: 'Member removed successfully'
    });
  } catch (error) {
    console.error('❌ Remove member error:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('❌ Rollback error:', rollbackError);
      } finally {
        connection.release();
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error removing member'
    });
  } finally {
    // Always release connection if it exists
    if (connection && connection.release) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error('❌ Connection release error:', releaseError);
      }
    }
  }
};

// @desc    Get chama statistics
// @route   GET /api/chamas/:id/stats
// @access  Private (Members only)
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

    // Get total payouts - handle if table doesn't exist
    let totalPayouts = 0;
    try {
      const [payoutResult] = await db.execute(
        `SELECT SUM(amount) as total FROM payouts 
         WHERE chama_id = ? AND status = 'paid'`,
        [req.params.id]
      );
      totalPayouts = payoutResult[0].total || 0;
    } catch (error) {
      console.warn('⚠️ Payouts table not found or error:', error.message);
      totalPayouts = 0; // Default to 0 if table doesn't exist
    }

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
    let currentCycleAmount = 0;
    
    if (currentCycle.length > 0) {
      const [cycleContributions] = await db.execute(
        `SELECT COUNT(DISTINCT member_id) as paid_count, SUM(amount) as total_amount
         FROM contributions 
         WHERE cycle_id = ? AND status = 'paid'`,
        [currentCycle[0].id]
      );
      currentCycleContributions = cycleContributions[0].paid_count;
      currentCycleAmount = cycleContributions[0].total_amount || 0;
    }

    // Get payment history (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const [paymentHistory] = await db.execute(
      `SELECT DATE_FORMAT(c.paid_date, '%Y-%m') as month, 
              COUNT(*) as payment_count, 
              SUM(c.amount) as total_amount
       FROM contributions c
       WHERE c.chama_id = ? 
         AND c.status = 'paid'
         AND c.paid_date >= ?
       GROUP BY DATE_FORMAT(c.paid_date, '%Y-%m')
       ORDER BY month DESC
       LIMIT 6`,
      [req.params.id, sixMonthsAgo.toISOString().split('T')[0]]
    );

    res.json({
      success: true,
      data: {
        totalContributions: totalResult[0].total || 0,
        totalPayouts: totalPayouts,
        currentBalance: (totalResult[0].total || 0) - totalPayouts,
        memberCount: memberCount[0].count,
        currentCycle: currentCycle.length > 0 ? currentCycle[0] : null,
        paidThisCycle: currentCycleContributions,
        amountThisCycle: currentCycleAmount,
        paymentRate: memberCount[0].count > 0 ? 
          (currentCycleContributions / memberCount[0].count) * 100 : 0,
        paymentHistory
      }
    });
  } catch (error) {
    console.error('❌ Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching statistics'
    });
  }
};

// @desc    Debug chama contributions
// @route   GET /api/chamas/:id/debug
// @access  Private (Development only)
const debugChama = async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  try {
    const chamaId = req.params.id;
    
    // Get chama details
    const [chama] = await db.execute(
      'SELECT * FROM chamas WHERE id = ?',
      [chamaId]
    );

    // Get members
    const [members] = await db.execute(
      'SELECT * FROM members WHERE chama_id = ?',
      [chamaId]
    );

    // Get cycles
    const [cycles] = await db.execute(
      'SELECT * FROM contribution_cycles WHERE chama_id = ? ORDER BY cycle_number',
      [chamaId]
    );

    // Get contributions
    const [contributions] = await db.execute(
      `SELECT c.*, u.name as member_name 
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       JOIN users u ON m.user_id = u.id
       WHERE c.chama_id = ?
       ORDER BY c.cycle_id, c.due_date`,
      [chamaId]
    );

    res.json({
      success: true,
      data: {
        chama: chama[0] || {},
        members: members,
        cycles: cycles,
        contributions: contributions,
        summary: {
          totalMembers: members.length,
          totalCycles: cycles.length,
          totalContributions: contributions.length,
          paidContributions: contributions.filter(c => c.status === 'paid').length,
          pendingContributions: contributions.filter(c => c.status === 'pending').length
        }
      }
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ success: false, message: 'Debug error' });
  }
};
// M-Pesa Configuration
const MPESA_CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY || '',
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || '',
  shortCode: process.env.MPESA_SHORTCODE || '',
  passkey: process.env.MPESA_PASSKEY || '',
  callbackURL: process.env.MPESA_CALLBACK_URL || 'https://yourdomain.com/api/payments/callback',
  environment: process.env.MPESA_ENVIRONMENT || 'sandbox', // sandbox or production
  transactionType: 'CustomerPayBillOnline'
};

// M-Pesa STK Push Service
class MpesaService {
  constructor() {
    this.isConfigured = false;
    
    if (MPESA_CONFIG.consumerKey && MPESA_CONFIG.consumerSecret) {
      this.isConfigured = true;
      console.log('✅ M-Pesa service configured');
    } else {
      console.warn('⚠️ M-Pesa credentials not found. Running in simulation mode.');
    }
  }

  /**
   * Get M-Pesa access token
   */
  async getAccessToken() {
    try {
      const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
      
      const response = await axios.get(
        MPESA_CONFIG.environment === 'production' 
          ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
          : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        {
          headers: {
            Authorization: `Basic ${auth}`
          }
        }
      );
      
      return response.data.access_token;
    } catch (error) {
      console.error('❌ M-Pesa access token error:', error.response?.data || error.message);
      throw new Error('Failed to get M-Pesa access token');
    }
  }

  /**
   * Generate timestamp in M-Pesa format (YYYYMMDDHHmmss)
   */
  generateTimestamp() {
    const now = new Date();
    return now.getFullYear().toString() +
           (now.getMonth() + 1).toString().padStart(2, '0') +
           now.getDate().toString().padStart(2, '0') +
           now.getHours().toString().padStart(2, '0') +
           now.getMinutes().toString().padStart(2, '0') +
           now.getSeconds().toString().padStart(2, '0');
  }

  /**
   * Generate password for STK Push
   */
  generatePassword(shortCode, passkey, timestamp) {
    const str = shortCode + passkey + timestamp;
    return Buffer.from(str).toString('base64');
  }

  /**
   * Initiate STK Push payment
   */
  async initiateSTKPush(phone, amount, reference, description = 'Chama Contribution') {
    try {
      if (!this.isConfigured) {
        // Simulation mode
        console.log(`📱 [SIMULATION] STK Push for ${phone}: KES ${amount}`);
        console.log(`📱 Reference: ${reference}, Description: ${description}`);
        
        // Simulate successful payment after delay
        return new Promise(resolve => {
          setTimeout(() => {
            resolve({
              success: true,
              mode: 'simulation',
              checkoutRequestID: `SIM-${Date.now()}`,
              merchantRequestID: `SIM-MR-${Date.now()}`,
              customerMessage: 'Success. Request accepted for processing',
              responseCode: '0',
              phone: phone,
              amount: amount,
              reference: reference,
              description: description
            });
          }, 2000);
        });
      }

      const accessToken = await this.getAccessToken();
      const timestamp = this.generateTimestamp();
      const password = this.generatePassword(MPESA_CONFIG.shortCode, MPESA_CONFIG.passkey, timestamp);
      
      // Format phone number (remove + and leading 0)
      let formattedPhone = phone.replace(/\D/g, '');
      if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
      } else if (formattedPhone.startsWith('254')) {
        formattedPhone = formattedPhone;
      } else {
        formattedPhone = '254' + formattedPhone;
      }

      const requestData = {
        BusinessShortCode: MPESA_CONFIG.shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: MPESA_CONFIG.transactionType,
        Amount: Math.round(amount), // Amount in whole shillings
        PartyA: formattedPhone,
        PartyB: MPESA_CONFIG.shortCode,
        PhoneNumber: formattedPhone,
        CallBackURL: MPESA_CONFIG.callbackURL,
        AccountReference: reference.substring(0, 12), // Max 12 chars
        TransactionDesc: description.substring(0, 13) // Max 13 chars
      };

      console.log('🔍 Initiating STK Push with data:', requestData);

      const response = await axios.post(
        MPESA_CONFIG.environment === 'production'
          ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
          : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
        requestData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('✅ STK Push initiated:', response.data);

      return {
        success: true,
        mode: 'production',
        checkoutRequestID: response.data.CheckoutRequestID,
        merchantRequestID: response.data.MerchantRequestID,
        customerMessage: response.data.CustomerMessage,
        responseCode: response.data.ResponseCode,
        phone: phone,
        amount: amount,
        reference: reference,
        description: description,
        rawResponse: response.data
      };
    } catch (error) {
      console.error('❌ STK Push error:', error.response?.data || error.message);
      
      const errorData = error.response?.data || {};
      let errorMessage = 'Failed to initiate payment';
      
      if (errorData.errorCode === '400.002.02') {
        errorMessage = 'Invalid phone number format';
      } else if (errorData.errorCode === '500.001.1001') {
        errorMessage = 'Insufficient balance';
      } else if (errorData.errorCode) {
        errorMessage = errorData.errorMessage || `Payment error: ${errorData.errorCode}`;
      }
      
      throw new Error(errorMessage);
    }
  }

  /**
   * Check STK Push status
   */
  async checkSTKStatus(checkoutRequestID) {
    try {
      if (!this.isConfigured) {
        // Simulation mode - always return success
        return {
          success: true,
          mode: 'simulation',
          resultCode: '0',
          resultDesc: 'The service request is processed successfully.',
          transactionComplete: true
        };
      }

      const accessToken = await this.getAccessToken();
      const timestamp = this.generateTimestamp();
      const password = this.generatePassword(MPESA_CONFIG.shortCode, MPESA_CONFIG.passkey, timestamp);

      const requestData = {
        BusinessShortCode: MPESA_CONFIG.shortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestID
      };

      const response = await axios.post(
        MPESA_CONFIG.environment === 'production'
          ? 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query'
          : 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query',
        requestData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const result = response.data;
      const transactionComplete = result.ResultCode === '0';
      
      return {
        success: true,
        mode: 'production',
        resultCode: result.ResultCode,
        resultDesc: result.ResultDesc,
        transactionComplete: transactionComplete,
        rawResponse: result
      };
    } catch (error) {
      console.error('❌ STK Status check error:', error.response?.data || error.message);
      throw new Error('Failed to check payment status');
    }
  }
}

// Initialize M-Pesa service
const mpesaService = new MpesaService();

// @desc    Initiate M-Pesa payment for contribution
// @route   POST /api/chamas/:id/payments/mpesa
// @access  Private (Members can pay their own, admins can pay for others)
const initiateMpesaPayment = async (req, res) => {
  const { memberId, amount, phone, description } = req.body;
  const chamaId = req.params.id;

  let connection;
  
  try {
    console.log('=== INITIATE MPESA PAYMENT START ===');
    console.log('Chama:', chamaId, 'Member:', memberId, 'Amount:', amount, 'Phone:', phone);

    if (!amount || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Please provide amount and phone number'
      });
    }

    // Validate amount
    if (amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    // Get database connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Check if user is authorized
    const [memberCheck] = await connection.execute(
      `SELECT m.id, m.user_id, u.name as member_name, c.contribution_amount
       FROM members m
       JOIN users u ON m.user_id = u.id
       JOIN chamas c ON m.chama_id = c.id
       WHERE m.chama_id = ? AND m.id = ?`,
      [chamaId, memberId]
    );

    if (memberCheck.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(404).json({
        success: false,
        message: 'Member not found in this chama'
      });
    }

    const member = memberCheck[0];
    
    // Check authorization: User can pay their own contribution or admin can pay for anyone
    const [authCheck] = await connection.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ?`,
      [chamaId, req.user.id]
    );

    const isAdmin = authCheck.length > 0 && authCheck[0].role === 'admin';
    const isSelfPayment = member.user_id === req.user.id;
    
    if (!isAdmin && !isSelfPayment) {
      await connection.rollback();
      connection.release();
      
      return res.status(403).json({
        success: false,
        message: 'Not authorized to make payment for this member'
      });
    }

    // Get current active cycle
    const [currentCycle] = await connection.execute(
      `SELECT * FROM contribution_cycles 
       WHERE chama_id = ? AND status = 'active'
       ORDER BY cycle_number DESC
       LIMIT 1`,
      [chamaId]
    );

    if (currentCycle.length === 0) {
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'No active contribution cycle found'
      });
    }

    const cycleId = currentCycle[0].id;
    
    // Find or create pending contribution
    const [pendingContribution] = await connection.execute(
      `SELECT id, amount FROM contributions 
       WHERE member_id = ? AND cycle_id = ? AND status = 'pending'
       ORDER BY due_date ASC
       LIMIT 1`,
      [memberId, cycleId]
    );

    let contributionId;
    let expectedAmount = amount;
    
    if (pendingContribution.length > 0) {
      contributionId = pendingContribution[0].id;
      expectedAmount = pendingContribution[0].amount;
      
      if (amount < expectedAmount) {
        await connection.rollback();
        connection.release();
        
        return res.status(400).json({
          success: false,
          message: `Amount must be at least KES ${expectedAmount} for this contribution`
        });
      }
    } else {
      // Create new contribution record
      const [contributionResult] = await connection.execute(
        `INSERT INTO contributions 
         (member_id, chama_id, cycle_id, amount, due_date, status) 
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [
          memberId,
          chamaId,
          cycleId,
          amount,
          new Date().toISOString().split('T')[0]
        ]
      );

      contributionId = contributionResult.insertId;
      expectedAmount = amount;
    }

    // Generate unique reference
    const reference = `CHAMA${chamaId.toString().padStart(4, '0')}${Date.now().toString().slice(-6)}`;
    
    // Create payment record (pending)
    const [paymentResult] = await connection.execute(
      `INSERT INTO mpesa_payments 
       (chama_id, member_id, contribution_id, phone_number, amount, 
        expected_amount, reference, description, status, initiated_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        chamaId,
        memberId,
        contributionId,
        phone,
        amount,
        expectedAmount,
        reference,
        description || `Chama ${chamaId} Contribution`,
        req.user.id
      ]
    );

    const mpesaPaymentId = paymentResult.insertId;
    console.log('✅ Payment record created with ID:', mpesaPaymentId);

    // Initiate STK Push
    console.log('🔍 Initiating STK Push...');
    const stkResult = await mpesaService.initiateSTKPush(
      phone,
      amount,
      reference,
      description || `Chama ${chamaId} Contribution`
    );

    console.log('✅ STK Push initiated:', stkResult);

    // Update payment record with STK details
    await connection.execute(
      `UPDATE mpesa_payments 
       SET checkout_request_id = ?, 
           merchant_request_id = ?,
           response_code = ?,
           customer_message = ?,
           status = 'initiated'
       WHERE id = ?`,
      [
        stkResult.checkoutRequestID,
        stkResult.merchantRequestID,
        stkResult.responseCode,
        stkResult.customerMessage,
        mpesaPaymentId
      ]
    );

    // Commit transaction
    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Payment initiated successfully. Please check your phone to complete the transaction.',
      data: {
        paymentId: mpesaPaymentId,
        checkoutRequestID: stkResult.checkoutRequestID,
        merchantRequestID: stkResult.merchantRequestID,
        customerMessage: stkResult.customerMessage,
        phone: phone,
        amount: amount,
        reference: reference,
        transactionStatus: 'initiated'
      }
    });
  } catch (error) {
    console.error('❌ Initiate M-Pesa payment error:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('❌ Rollback error:', rollbackError);
      } finally {
        connection.release();
      }
    }
    
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to initiate payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    // Always release connection if it exists
    if (connection && connection.release) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error('❌ Connection release error:', releaseError);
      }
    }
  }
};

// @desc    M-Pesa payment callback (called by Safaricom)
// @route   POST /api/payments/mpesa-callback
// @access  Public
const mpesaCallback = async (req, res) => {
  console.log('=== MPESA CALLBACK RECEIVED ===');
  console.log('Callback body:', JSON.stringify(req.body, null, 2));

  let connection;
  
  try {
    const callbackData = req.body;
    
    if (!callbackData.Body || !callbackData.Body.stkCallback) {
      console.error('❌ Invalid callback format');
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback format' });
    }

    const stkCallback = callbackData.Body.stkCallback;
    const checkoutRequestID = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;
    const resultDesc = stkCallback.ResultDesc;
    const callbackMetadata = stkCallback.CallbackMetadata;

    console.log('🔍 Processing callback for:', checkoutRequestID);
    console.log('Result Code:', resultCode, 'Description:', resultDesc);

    // Get database connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Find payment record
    const [paymentRecords] = await connection.execute(
      `SELECT * FROM mpesa_payments 
       WHERE checkout_request_id = ?`,
      [checkoutRequestID]
    );

    if (paymentRecords.length === 0) {
      console.error('❌ Payment record not found for:', checkoutRequestID);
      await connection.rollback();
      connection.release();
      
      return res.status(404).json({ ResultCode: 1, ResultDesc: 'Payment record not found' });
    }

    const payment = paymentRecords[0];
    console.log('✅ Found payment record:', payment.id);

    // Extract payment details from callback
    let mpesaReceiptNumber = null;
    let transactionDate = null;
    let phoneNumber = null;
    let amount = payment.amount;

    if (callbackMetadata && callbackMetadata.Item) {
      callbackMetadata.Item.forEach(item => {
        if (item.Name === 'MpesaReceiptNumber') {
          mpesaReceiptNumber = item.Value;
        } else if (item.Name === 'TransactionDate') {
          transactionDate = item.Value;
        } else if (item.Name === 'PhoneNumber') {
          phoneNumber = item.Value;
        } else if (item.Name === 'Amount') {
          amount = item.Value;
        }
      });
    }

    // Update payment record
    const paymentStatus = resultCode === '0' ? 'completed' : 'failed';
    
    await connection.execute(
      `UPDATE mpesa_payments 
       SET status = ?,
           result_code = ?,
           result_description = ?,
           mpesa_receipt_number = ?,
           transaction_date = ?,
           phone_number = COALESCE(?, phone_number),
           amount = COALESCE(?, amount),
           callback_received_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        paymentStatus,
        resultCode,
        resultDesc,
        mpesaReceiptNumber,
        transactionDate,
        phoneNumber,
        amount,
        payment.id
      ]
    );

    console.log('✅ Payment record updated with status:', paymentStatus);

    // If payment successful, update contribution and record payment
    if (resultCode === '0') {
      // Update contribution status
      await connection.execute(
        `UPDATE contributions 
         SET status = 'paid',
             paid_date = ?,
             payment_method = 'mpesa',
             reference_number = ?,
             verified_by = ?,
             amount = COALESCE(?, amount)
         WHERE id = ?`,
        [
          transactionDate ? new Date(transactionDate) : new Date(),
          mpesaReceiptNumber,
          payment.initiated_by,
          amount,
          payment.contribution_id
        ]
      );

      // Record payment transaction
      await connection.execute(
        `INSERT INTO payments 
         (chama_id, member_id, contribution_id, amount, payment_method,
          payment_date, reference_number, recorded_by, notes) 
         VALUES (?, ?, ?, ?, 'mpesa', ?, ?, ?, ?)`,
        [
          payment.chama_id,
          payment.member_id,
          payment.contribution_id,
          amount,
          transactionDate ? new Date(transactionDate) : new Date(),
          mpesaReceiptNumber,
          payment.initiated_by,
          `M-Pesa payment via STK Push. Receipt: ${mpesaReceiptNumber}`
        ]
      );

      // Update chama statistics
      await connection.execute(
        `UPDATE chamas 
         SET updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [payment.chama_id]
      );

      console.log('✅ Contribution updated and payment recorded');
      
      // Get member details for notification
      const [memberDetails] = await connection.execute(
        `SELECT u.name, u.phone, c.name as chama_name 
         FROM members m
         JOIN users u ON m.user_id = u.id
         JOIN chamas c ON m.chama_id = c.id
         WHERE m.id = ?`,
        [payment.member_id]
      );

      if (memberDetails.length > 0) {
        const member = memberDetails[0];
        
        // Send confirmation SMS (you can integrate with your SMS service)
        try {
          console.log(`📱 Payment confirmation for ${member.name}: KES ${amount} to ${member.chama_name}`);
          // await smsService.sendPaymentConfirmation(member.phone, member.name, amount, member.chama_name, mpesaReceiptNumber);
        } catch (smsError) {
          console.warn('⚠️ Failed to send confirmation SMS:', smsError.message);
        }
      }
    }

    // Commit transaction
    await connection.commit();

    // Send response to Safaricom
    res.json({
      ResultCode: 0,
      ResultDesc: "Success"
    });

    console.log('✅ Callback processing completed successfully');

  } catch (error) {
    console.error('❌ M-Pesa callback error:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('❌ Rollback error:', rollbackError);
      } finally {
        connection.release();
      }
    }
    
    // Still respond to Safaricom to prevent retries
    res.json({
      ResultCode: 0,
      ResultDesc: "Success" // Always return success to prevent retries
    });
  } finally {
    // Always release connection if it exists
    if (connection && connection.release) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error('❌ Connection release error:', releaseError);
      }
    }
  }
};

// @desc    Check payment status
// @route   GET /api/chamas/:id/payments/:paymentId/status
// @access  Private
const checkPaymentStatus = async (req, res) => {
  const { paymentId } = req.params;

  try {
    console.log('🔍 Checking payment status for ID:', paymentId);

    // Get payment details
    const [paymentRecords] = await db.execute(
      `SELECT mp.*, u.name as member_name, c.name as chama_name
       FROM mpesa_payments mp
       JOIN members m ON mp.member_id = m.id
       JOIN users u ON m.user_id = u.id
       JOIN chamas c ON mp.chama_id = c.id
       WHERE mp.id = ?`,
      [paymentId]
    );

    if (paymentRecords.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found'
      });
    }

    const payment = paymentRecords[0];

    // Check if user is authorized to view this payment
    const [authCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ?`,
      [payment.chama_id, req.user.id]
    );

    const isAdmin = authCheck.length > 0 && authCheck[0].role === 'admin';
    const isOwner = payment.initiated_by === req.user.id;
    
    if (!isAdmin && !isOwner) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this payment'
      });
    }

    // If payment is pending and has checkout request ID, check status with M-Pesa
    let stkStatus = null;
    if (payment.status === 'initiated' && payment.checkout_request_id) {
      try {
        stkStatus = await mpesaService.checkSTKStatus(payment.checkout_request_id);
        
        // Update status if changed
        if (stkStatus.transactionComplete) {
          await db.execute(
            `UPDATE mpesa_payments 
             SET status = 'completed',
                 result_code = ?,
                 result_description = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [stkStatus.resultCode, stkStatus.resultDesc, paymentId]
          );
          
          // Also update contribution if not already done via callback
          if (payment.contribution_id) {
            await db.execute(
              `UPDATE contributions 
               SET status = 'paid',
                   paid_date = CURRENT_DATE,
                   payment_method = 'mpesa',
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'pending'`,
              [payment.contribution_id]
            );
          }
        }
      } catch (statusError) {
        console.warn('⚠️ Failed to check STK status:', statusError.message);
      }
    }

    // Get updated payment details
    const [updatedPayment] = await db.execute(
      `SELECT * FROM mpesa_payments WHERE id = ?`,
      [paymentId]
    );

    res.json({
      success: true,
      data: {
        payment: updatedPayment[0],
        stkStatus: stkStatus,
        memberName: payment.member_name,
        chamaName: payment.chama_name
      }
    });

  } catch (error) {
    console.error('❌ Check payment status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check payment status'
    });
  }
};

// @desc    Get payment history for chama
// @route   GET /api/chamas/:id/payments/history
// @access  Private (Admin only)
const getPaymentHistory = async (req, res) => {
  const chamaId = req.params.id;
  const { status, startDate, endDate, memberId } = req.query;

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

    let query = `
      SELECT mp.*, u.name as member_name, u.phone,
             c.name as chama_name, co.amount as contribution_amount,
             cc.cycle_number
      FROM mpesa_payments mp
      JOIN members m ON mp.member_id = m.id
      JOIN users u ON m.user_id = u.id
      JOIN chamas c ON mp.chama_id = c.id
      LEFT JOIN contributions co ON mp.contribution_id = co.id
      LEFT JOIN contribution_cycles cc ON co.cycle_id = cc.id
      WHERE mp.chama_id = ?
    `;
    
    const params = [chamaId];
    
    if (status) {
      query += ' AND mp.status = ?';
      params.push(status);
    }
    
    if (memberId) {
      query += ' AND mp.member_id = ?';
      params.push(memberId);
    }
    
    if (startDate) {
      query += ' AND DATE(mp.created_at) >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND DATE(mp.created_at) <= ?';
      params.push(endDate);
    }
    
    query += ' ORDER BY mp.created_at DESC';
    
    const [payments] = await db.execute(query, params);

    // Get summary statistics
    const totalPayments = payments.length;
    const completedPayments = payments.filter(p => p.status === 'completed').length;
    const pendingPayments = payments.filter(p => p.status === 'pending' || p.status === 'initiated').length;
    const failedPayments = payments.filter(p => p.status === 'failed').length;
    const totalAmount = payments
      .filter(p => p.status === 'completed')
      .reduce((sum, p) => sum + parseFloat(p.amount), 0);

    res.json({
      success: true,
      data: {
        payments,
        summary: {
          total: totalPayments,
          completed: completedPayments,
          pending: pendingPayments,
          failed: failedPayments,
          totalAmount: totalAmount
        }
      }
    });
  } catch (error) {
    console.error('❌ Get payment history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get payment history'
    });
  }
};

// @desc    Get my payment history
// @route   GET /api/chamas/:id/my-payments
// @access  Private
const getMyPayments = async (req, res) => {
  const chamaId = req.params.id;

  try {
    // Check if user is a member
    const [member] = await db.execute(
      'SELECT id FROM members WHERE chama_id = ? AND user_id = ?',
      [chamaId, req.user.id]
    );

    if (member.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not a member of this chama'
      });
    }

    const memberId = member[0].id;
    
    const [payments] = await db.execute(
      `SELECT mp.*, c.name as chama_name, co.amount as contribution_amount,
              cc.cycle_number, mp.status as payment_status
       FROM mpesa_payments mp
       JOIN chamas c ON mp.chama_id = c.id
       LEFT JOIN contributions co ON mp.contribution_id = co.id
       LEFT JOIN contribution_cycles cc ON co.cycle_id = cc.id
       WHERE mp.chama_id = ? AND mp.member_id = ?
       ORDER BY mp.created_at DESC`,
      [chamaId, memberId]
    );

    res.json({
      success: true,
      data: payments
    });
  } catch (error) {
    console.error('❌ Get my payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get payment history'
    });
  }
};

// Update the existing recordPayment function to handle M-Pesa separately

// Add M-Pesa payment table schema
const createMpesaPaymentsTable = `
CREATE TABLE IF NOT EXISTS mpesa_payments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  chama_id INT NOT NULL,
  member_id INT NOT NULL,
  contribution_id INT NULL,
  phone_number VARCHAR(20) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  expected_amount DECIMAL(10, 2) NOT NULL,
  reference VARCHAR(50) NOT NULL UNIQUE,
  description VARCHAR(255),
  checkout_request_id VARCHAR(100),
  merchant_request_id VARCHAR(100),
  response_code VARCHAR(10),
  customer_message VARCHAR(255),
  result_code VARCHAR(10),
  result_description VARCHAR(255),
  mpesa_receipt_number VARCHAR(50),
  transaction_date VARCHAR(20),
  status ENUM('pending', 'initiated', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
  initiated_by INT NOT NULL,
  callback_received_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (chama_id) REFERENCES chamas(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (contribution_id) REFERENCES contributions(id) ON DELETE SET NULL,
  FOREIGN KEY (initiated_by) REFERENCES users(id),
  INDEX idx_checkout_request (checkout_request_id),
  INDEX idx_reference (reference),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  INDEX idx_chama_member (chama_id, member_id)
);
`;

// Run this during database setup
const initializeMpesaTables = async () => {
  try {
    await db.execute(createMpesaPaymentsTable);
    console.log('✅ M-Pesa payments table created/verified');
  } catch (error) {
    console.error('❌ Failed to create M-Pesa payments table:', error);
  }
};

// Call this function during app startup
initializeMpesaTables();

module.exports = {
  createChama,
  getMyChamas,
  getChama,
  updateChama,
  addMember,
  removeMember,
  getChamaStats,
  createContributionCycle,
  getContributions,
  getMyContributions,
  debugChama,
  // M-Pesa payment functions
  initiateMpesaPayment,
  mpesaCallback,
  checkPaymentStatus,
  getPaymentHistory,
  getMyPayments
};