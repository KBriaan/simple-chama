// middleware/chamaMiddleware.js
const db = require('../config/database');

const isChamaMember = async (req, res, next) => {
  try {
    const chamaId = req.params.chamaId || req.body.chamaId || req.query.chamaId;
    
    if (!chamaId) {
      return res.status(400).json({
        success: false,
        message: 'Chama ID is required'
      });
    }

    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ?',
      [chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not a member of this chama'
      });
    }

    req.memberRole = membership[0].role;
    req.chamaId = chamaId;
    next();
  } catch (error) {
    console.error('Chama middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error checking membership'
    });
  }
};

const isChamaAdmin = async (req, res, next) => {
  try {
    const chamaId = req.params.chamaId || req.body.chamaId || req.query.chamaId;
    
    if (!chamaId) {
      return res.status(400).json({
        success: false,
        message: 'Chama ID is required'
      });
    }

    const [membership] = await db.execute(
      'SELECT role FROM members WHERE chama_id = ? AND user_id = ? AND role = "admin"',
      [chamaId, req.user.id]
    );

    if (membership.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized as admin of this chama'
      });
    }

    req.chamaId = chamaId;
    next();
  } catch (error) {
    console.error('Chama admin middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error checking admin permissions'
    });
  }
};

// Check if user can access member data (self or admin)
const canAccessMember = async (req, res, next) => {
  try {
    const memberId = req.params.memberId;
    
    if (!memberId) {
      return next();
    }

    // Get member details
    const [member] = await db.execute(
      `SELECT m.*, m.user_id as member_user_id, m.chama_id 
       FROM members m
       WHERE m.id = ?`,
      [memberId]
    );

    if (member.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    // Check if user is the member themselves
    const isSelf = member[0].member_user_id === req.user.id;

    // Check if user is admin of the chama
    const [adminCheck] = await db.execute(
      `SELECT role FROM members 
       WHERE chama_id = ? AND user_id = ? AND role = 'admin'`,
      [member[0].chama_id, req.user.id]
    );
    
    const isAdmin = adminCheck.length > 0;

    if (!isSelf && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this member data'
      });
    }

    req.memberData = member[0];
    next();
  } catch (error) {
    console.error('Member access middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error checking member access'
    });
  }
};

module.exports = {
  isChamaMember,
  isChamaAdmin,
  canAccessMember
};