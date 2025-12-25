const db = require('../config/database');

// Helper function to create notification
const createNotification = async (userId, title, message, type = 'info', relatedId = null, relatedType = null) => {
  try {
    await db.execute(
      `INSERT INTO notifications 
       (user_id, title, message, type, is_read, related_id, related_type) 
       VALUES (?, ?, ?, ?, false, ?, ?)`,
      [userId, title, message, type, relatedId, relatedType]
    );
  } catch (error) {
    console.error('Create notification error:', error);
  }
};

// @desc    Get user notifications
// @route   GET /api/notifications
// @access  Private
const getNotifications = async (req, res) => {
  try {
    const { limit = 50, offset = 0, unreadOnly = false } = req.query;
    
    let query = `
      SELECT * FROM notifications 
      WHERE user_id = ?
    `;
    
    const params = [req.user.id];

    if (unreadOnly === 'true') {
      query += ' AND is_read = false';
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [notifications] = await db.execute(query, params);

    // Get total count for pagination
    const [countResult] = await db.execute(
      `SELECT 
         COUNT(*) as total,
         SUM(CASE WHEN is_read = false THEN 1 ELSE 0 END) as unread_count
       FROM notifications 
       WHERE user_id = ?`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        notifications,
        pagination: {
          total: countResult[0].total,
          unread: countResult[0].unread_count,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      }
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error fetching notifications'
    });
  }
};

// @desc    Mark notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
const markAsRead = async (req, res) => {
  try {
    // Check if notification belongs to user
    const [notifications] = await db.execute(
      'SELECT id FROM notifications WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (notifications.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    await db.execute(
      'UPDATE notifications SET is_read = true, read_at = CURRENT_TIMESTAMP WHERE id = ?',
      [req.params.id]
    );

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating notification'
    });
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
// @access  Private
const markAllAsRead = async (req, res) => {
  try {
    await db.execute(
      'UPDATE notifications SET is_read = true, read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND is_read = false',
      [req.user.id]
    );

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Mark all as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error updating notifications'
    });
  }
};

// @desc    Delete notification
// @route   DELETE /api/notifications/:id
// @access  Private
const deleteNotification = async (req, res) => {
  try {
    // Check if notification belongs to user
    const [notifications] = await db.execute(
      'SELECT id FROM notifications WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (notifications.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    await db.execute('DELETE FROM notifications WHERE id = ?', [req.params.id]);

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting notification'
    });
  }
};

// Notification triggers (to be called from other controllers)
const NotificationService = {
  // Trigger when contribution is recorded
  onContributionRecorded: async (memberId, amount, recordedByUserId) => {
    try {
      // Get member details
      const [members] = await db.execute(
        `SELECT m.user_id, u.name as member_name, c.name as chama_name
         FROM members m
         JOIN users u ON m.user_id = u.id
         JOIN chamas c ON m.chama_id = c.id
         WHERE m.id = ?`,
        [memberId]
      );

      if (members.length === 0) return;

      const member = members[0];

      // Notify the member
      await createNotification(
        member.user_id,
        'Contribution Recorded',
        `Your contribution of ${amount} has been recorded for ${member.chama_name}`,
        'success',
        memberId,
        'contribution'
      );

      // Notify admins (except the one who recorded)
      const [admins] = await db.execute(
        `SELECT DISTINCT m.user_id, u.name
         FROM members m
         JOIN users u ON m.user_id = u.id
         WHERE m.chama_id = (
           SELECT chama_id FROM members WHERE id = ?
         ) AND m.role = 'admin' AND m.user_id != ?`,
        [memberId, recordedByUserId]
      );

      for (const admin of admins) {
        await createNotification(
          admin.user_id,
          'New Contribution',
          `${member.member_name} made a contribution of ${amount} to ${member.chama_name}`,
          'info',
          memberId,
          'contribution'
        );
      }
    } catch (error) {
      console.error('Notification trigger error:', error);
    }
  },

  // Trigger when payout is created
  onPayoutCreated: async (memberId, amount) => {
    try {
      // Get member details
      const [members] = await db.execute(
        `SELECT m.user_id, u.name as member_name, c.name as chama_name
         FROM members m
         JOIN users u ON m.user_id = u.id
         JOIN chamas c ON m.chama_id = c.id
         WHERE m.id = ?`,
        [memberId]
      );

      if (members.length === 0) return;

      const member = members[0];

      // Notify the member
      await createNotification(
        member.user_id,
        'Payout Created',
        `A payout of ${amount} has been created for you from ${member.chama_name}`,
        'success',
        memberId,
        'payout'
      );
    } catch (error) {
      console.error('Payout notification error:', error);
    }
  },

  // Trigger when due date is approaching
  checkDueDates: async () => {
    try {
      // Get members with due contributions in the next 3 days
      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

      const [dueMembers] = await db.execute(
        `SELECT DISTINCT m.user_id, u.name as member_name, 
                c.name as chama_name, cc.due_date,
                DATEDIFF(cc.due_date, CURDATE()) as days_remaining
         FROM members m
         JOIN users u ON m.user_id = u.id
         JOIN chamas c ON m.chama_id = c.id
         JOIN contribution_cycles cc ON c.id = cc.chama_id AND cc.status = 'active'
         LEFT JOIN contributions cont ON m.id = cont.member_id AND cont.cycle_id = cc.id AND cont.status = 'paid'
         WHERE cont.id IS NULL 
           AND cc.due_date <= ?
           AND cc.due_date >= CURDATE()`,
        [threeDaysFromNow.toISOString().split('T')[0]]
      );

      for (const member of dueMembers) {
        await createNotification(
          member.user_id,
          'Contribution Due Soon',
          `Your contribution for ${member.chama_name} is due in ${member.days_remaining} days (${member.due_date})`,
          'warning',
          member.user_id,
          'reminder'
        );
      }
    } catch (error) {
      console.error('Due date check error:', error);
    }
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  NotificationService,
  createNotification
};