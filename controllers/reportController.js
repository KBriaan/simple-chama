const db = require('../config/database');

// @desc    Get chama financial report
// @route   GET /api/reports/chama/:chamaId/financial
// @access  Private (Members only)
const getFinancialReport = async (req, res) => {
  try {
    // Check if user is a member
    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view reports for this chama'
      });
    }

    const { startDate, endDate } = req.query;

    // Build date filter
    let dateFilter = '';
    const params = [req.params.chamaId];
    
    if (startDate && endDate) {
      dateFilter = ' AND DATE(t.created_at) BETWEEN ? AND ?';
      params.push(startDate, endDate);
    } else if (startDate) {
      dateFilter = ' AND DATE(t.created_at) >= ?';
      params.push(startDate);
    } else if (endDate) {
      dateFilter = ' AND DATE(t.created_at) <= ?';
      params.push(endDate);
    }

    // Get transaction summary
    const [transactions] = await db.execute(
      `SELECT 
         transaction_type,
         COUNT(*) as count,
         SUM(amount) as total_amount
       FROM transactions
       WHERE chama_id = ? ${dateFilter}
       GROUP BY transaction_type
       ORDER BY transaction_type`,
      params
    );

    // Get monthly contributions
    const [monthlyContributions] = await db.execute(
      `SELECT 
         DATE_FORMAT(c.payment_date, '%Y-%m') as month,
         COUNT(*) as contribution_count,
         SUM(c.amount) as total_amount,
         COUNT(DISTINCT c.member_id) as unique_members
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       WHERE m.chama_id = ? AND c.status = 'paid'
         ${startDate ? ' AND DATE(c.payment_date) >= ?' : ''}
         ${endDate ? ' AND DATE(c.payment_date) <= ?' : ''}
       GROUP BY DATE_FORMAT(c.payment_date, '%Y-%m')
       ORDER BY month DESC`,
      [req.params.chamaId, ...(startDate ? [startDate] : []), ...(endDate ? [endDate] : [])]
    );

    // Get member performance
    const [memberPerformance] = await db.execute(
      `SELECT 
         m.id as member_id,
         u.name,
         u.phone,
         COUNT(c.id) as contributions_count,
         SUM(c.amount) as total_contributions,
         COUNT(p.id) as payouts_count,
         SUM(p.amount) as total_payouts,
         (SUM(c.amount) - COALESCE(SUM(p.amount), 0)) as net_balance
       FROM members m
       JOIN users u ON m.user_id = u.id
       LEFT JOIN contributions c ON m.id = c.member_id AND c.status = 'paid'
       LEFT JOIN payouts p ON m.id = p.member_id AND p.status = 'paid'
       WHERE m.chama_id = ?
       GROUP BY m.id, u.name, u.phone
       ORDER BY net_balance DESC`,
      [req.params.chamaId]
    );

    // Get cycle performance
    const [cyclePerformance] = await db.execute(
      `SELECT 
         cc.id,
         cc.cycle_number,
         cc.cycle_date,
         cc.due_date,
         cc.status,
         COUNT(DISTINCT c.member_id) as members_contributed,
         COUNT(DISTINCT m.id) as total_members,
         SUM(c.amount) as total_contributions,
         COUNT(DISTINCT p.member_id) as members_paid_out,
         SUM(p.amount) as total_payouts
       FROM contribution_cycles cc
       LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.status = 'paid'
       LEFT JOIN members m ON cc.chama_id = m.chama_id
       LEFT JOIN payouts p ON cc.id = p.cycle_id AND p.status = 'paid'
       WHERE cc.chama_id = ?
       GROUP BY cc.id, cc.cycle_number, cc.cycle_date, cc.due_date, cc.status
       ORDER BY cc.cycle_number DESC`,
      [req.params.chamaId]
    );

    res.json({
      success: true,
      data: {
        transactionSummary: transactions,
        monthlyContributions,
        memberPerformance,
        cyclePerformance,
        reportDate: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Get financial report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error generating financial report'
    });
  }
};

// @desc    Get member statement
// @route   GET /api/reports/member/:memberId/statement
// @access  Private (Self or Admin)
const getMemberStatement = async (req, res) => {
  try {
    // Get member details
    const [members] = await db.execute(
      `SELECT m.*, u.name, u.phone, c.name as chama_name,
              c.contribution_amount
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
        message: 'Not authorized to view this statement'
      });
    }

    const isAdmin = permission[0].role === 'admin';
    const isSelf = member.user_id === req.user.id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this statement'
      });
    }

    const { startDate, endDate } = req.query;

    // Get contributions
    let contributionQuery = `
      SELECT 
        c.id,
        c.amount,
        c.payment_method,
        c.payment_date,
        c.status,
        cc.cycle_number,
        'contribution' as transaction_type,
        u.name as recorded_by_name
      FROM contributions c
      JOIN contribution_cycles cc ON c.cycle_id = cc.id
      LEFT JOIN users u ON c.recorded_by = u.id
      WHERE c.member_id = ?
    `;

    const contributionParams = [req.params.memberId];

    if (startDate) {
      contributionQuery += ' AND DATE(c.payment_date) >= ?';
      contributionParams.push(startDate);
    }
    if (endDate) {
      contributionQuery += ' AND DATE(c.payment_date) <= ?';
      contributionParams.push(endDate);
    }

    contributionQuery += ' ORDER BY c.payment_date DESC';

    const [contributions] = await db.execute(contributionQuery, contributionParams);

    // Get payouts
    let payoutQuery = `
      SELECT 
        p.id,
        p.amount,
        p.payout_date,
        p.status,
        p.notes,
        cc.cycle_number,
        'payout' as transaction_type
      FROM payouts p
      JOIN contribution_cycles cc ON p.cycle_id = cc.id
      WHERE p.member_id = ?
    `;

    const payoutParams = [req.params.memberId];

    if (startDate) {
      payoutQuery += ' AND DATE(p.payout_date) >= ?';
      payoutParams.push(startDate);
    }
    if (endDate) {
      payoutQuery += ' AND DATE(p.payout_date) <= ?';
      payoutParams.push(endDate);
    }

    payoutQuery += ' ORDER BY p.payout_date DESC';

    const [payouts] = await db.execute(payoutQuery, payoutParams);

    // Combine and sort all transactions
    const allTransactions = [
      ...contributions.map(c => ({
        ...c,
        transaction_type: 'contribution',
        date: c.payment_date
      })),
      ...payouts.map(p => ({
        ...p,
        transaction_type: 'payout',
        date: p.payout_date
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate totals
    const totalContributions = contributions
      .filter(c => c.status === 'paid')
      .reduce((sum, c) => sum + parseFloat(c.amount), 0);

    const totalPayouts = payouts
      .filter(p => p.status === 'paid')
      .reduce((sum, p) => sum + parseFloat(p.amount), 0);

    const netBalance = totalContributions - totalPayouts;

    // Get chama details
    const [chamaDetails] = await db.execute(
      `SELECT 
         COUNT(*) as total_members,
         AVG(contribution_amount) as avg_contribution
       FROM chamas 
       WHERE id = ?`,
      [member.chama_id]
    );

    // Get member's contribution rate
    const [contributionRate] = await db.execute(
      `SELECT 
         COUNT(DISTINCT cc.id) as total_cycles,
         COUNT(DISTINCT c.cycle_id) as cycles_contributed
       FROM contribution_cycles cc
       LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.member_id = ? AND c.status = 'paid'
       WHERE cc.chama_id = ?`,
      [req.params.memberId, member.chama_id]
    );

    const contributionPercentage = contributionRate[0].total_cycles > 0 
      ? (contributionRate[0].cycles_contributed / contributionRate[0].total_cycles) * 100 
      : 0;

    res.json({
      success: true,
      data: {
        member: {
          id: member.id,
          name: member.name,
          phone: member.phone,
          chamaName: member.chama_name,
          role: member.role,
          joinedAt: member.joined_at
        },
        summary: {
          totalContributions,
          totalPayouts,
          netBalance,
          contributionPercentage: contributionPercentage.toFixed(2),
          chamaAverageContribution: chamaDetails[0].avg_contribution,
          chamaTotalMembers: chamaDetails[0].total_members
        },
        transactions: allTransactions,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Get member statement error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error generating member statement'
    });
  }
};

// @desc    Get chama dashboard statistics
// @route   GET /api/reports/chama/:chamaId/dashboard
// @access  Private (Members only)
const getDashboardStats = async (req, res) => {
  try {
    // Check if user is a member
    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [req.params.chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view dashboard for this chama'
      });
    }

    // Get basic stats
    const [basicStats] = await db.execute(
      `SELECT 
         COUNT(DISTINCT m.id) as total_members,
         COUNT(DISTINCT CASE WHEN m.role = 'admin' THEN m.id END) as admin_count,
         c.contribution_amount,
         c.contribution_cycle,
         c.created_at as chama_created
       FROM chamas c
       LEFT JOIN members m ON c.id = m.chama_id
       WHERE c.id = ?
       GROUP BY c.id, c.contribution_amount, c.contribution_cycle, c.created_at`,
      [req.params.chamaId]
    );

    // Get financial stats
    const [financialStats] = await db.execute(
      `SELECT 
         COALESCE(SUM(CASE WHEN c.status = 'paid' THEN c.amount ELSE 0 END), 0) as total_contributions,
         COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) as total_payouts,
         COUNT(DISTINCT CASE WHEN c.status = 'paid' THEN c.member_id END) as members_with_contributions,
         COUNT(DISTINCT CASE WHEN p.status = 'paid' THEN p.member_id END) as members_with_payouts
       FROM chamas ch
       LEFT JOIN members m ON ch.id = m.chama_id
       LEFT JOIN contributions c ON m.id = c.member_id
       LEFT JOIN payouts p ON m.id = p.member_id
       WHERE ch.id = ?`,
      [req.params.chamaId]
    );

    // Get current cycle stats
    const [currentCycle] = await db.execute(
      `SELECT 
         cc.*,
         COUNT(DISTINCT c.member_id) as paid_members,
         COUNT(DISTINCT m.id) as total_members_in_chama,
         SUM(c.amount) as cycle_contributions
       FROM contribution_cycles cc
       LEFT JOIN members m ON cc.chama_id = m.chama_id
       LEFT JOIN contributions c ON cc.id = c.cycle_id AND c.status = 'paid'
       WHERE cc.chama_id = ? AND cc.status = 'active'
       GROUP BY cc.id, cc.cycle_number, cc.cycle_date, cc.due_date, cc.status`,
      [req.params.chamaId]
    );

    // Get recent transactions
    const [recentTransactions] = await db.execute(
      `SELECT 
         t.*,
         u.name as created_by_name
       FROM transactions t
       JOIN users u ON t.created_by = u.id
       WHERE t.chama_id = ?
       ORDER BY t.created_at DESC
       LIMIT 10`,
      [req.params.chamaId]
    );

    // Get upcoming due dates
    const [upcomingDue] = await db.execute(
      `SELECT 
         m.id as member_id,
         u.name as member_name,
         u.phone as member_phone,
         cc.due_date,
         CASE 
           WHEN c.id IS NOT NULL THEN 'paid'
           ELSE 'pending'
         END as payment_status
       FROM members m
       JOIN users u ON m.user_id = u.id
       CROSS JOIN (
         SELECT * FROM contribution_cycles 
         WHERE chama_id = ? AND status = 'active'
         ORDER BY cycle_number DESC LIMIT 1
       ) cc
       LEFT JOIN contributions c ON m.id = c.member_id AND c.cycle_id = cc.id AND c.status = 'paid'
       WHERE m.chama_id = ?
       ORDER BY cc.due_date`,
      [req.params.chamaId, req.params.chamaId]
    );

    const pendingPayments = upcomingDue.filter(item => item.payment_status === 'pending');

    res.json({
      success: true,
      data: {
        basicStats: basicStats[0],
        financialStats: financialStats[0],
        currentCycle: currentCycle.length > 0 ? currentCycle[0] : null,
        recentTransactions,
        pendingPaymentsCount: pendingPayments.length,
        pendingPayments: pendingPayments.slice(0, 5), // Only first 5
        totalPendingAmount: pendingPayments.length * (basicStats[0]?.contribution_amount || 0),
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error generating dashboard statistics'
    });
  }
};

module.exports = {
  getFinancialReport,
  getMemberStatement,
  getDashboardStats
};