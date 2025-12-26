// TOP OF THE FILE - Add this debugging
console.log('🔍 authController: Loading database...');
const db = require('../config/database');
console.log('🔍 authController: db loaded, has execute?', typeof db.execute === 'function');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Import SMS Service
const smsService = require('../utils/smsService');

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE
  });
};

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
const register = async (req, res) => {
  console.log('📝 Register endpoint called');
  const { name, phone, email, password } = req.body;
  
  // Start transaction
  let connection;
  
  try {
    // Validate required fields
    if (!name || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, phone and password'
      });
    }

    // Validate phone number format
    if (!smsService.isValidPhoneNumber(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid phone number with country code (e.g., +919876543210)'
      });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }

    console.log('🔍 Getting database connection for transaction');
    
    // Get a connection from the pool for transaction
    connection = await db.getConnection();
    
    // Start transaction
    console.log('🔍 Starting transaction');
    await connection.beginTransaction();

    console.log('🔍 Checking if user exists:', phone);
    
    // Check if user exists
    const [existingUsers] = await connection.execute(
      'SELECT id FROM users WHERE phone = ? OR email = ?',
      [phone, email || '']
    );

    if (existingUsers.length > 0) {
      // Rollback transaction before returning error
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'User with this phone or email already exists'
      });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Insert user
    console.log('🔍 Inserting new user');
    const [result] = await connection.execute(
      'INSERT INTO users (name, phone, email, password_hash) VALUES (?, ?, ?, ?)',
      [name, phone, email || null, hashedPassword]
    );

    // Commit transaction
    console.log('🔍 Committing transaction');
    await connection.commit();

    // Send welcome SMS (non-blocking, don't fail registration if SMS fails)
    try {
      const smsResult = await smsService.sendWelcomeMessage(phone, name);
      console.log(`✅ Welcome SMS sent to ${phone}: ${smsResult.messageId}`);
    } catch (smsError) {
      console.warn('⚠️ Welcome SMS failed to send:', smsError.message);
      // Don't fail registration if SMS fails
    }

    // Get created user with a new connection (transaction is complete)
    const [users] = await db.execute(
      'SELECT id, name, phone, email, created_at FROM users WHERE id = ?',
      [result.insertId]
    );

    const user = users[0];

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        user,
        token: generateToken(user.id)
      }
    });
  } catch (error) {
    console.error('❌ Registration error:', error);
    
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
      message: 'Server error during registration',
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

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
const login = async (req, res) => {
  console.log('🔑 Login endpoint called');
  const { phone, password } = req.body;

  try {
    // Validate
    if (!phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone and password'
      });
    }

    console.log('🔍 Checking for user with phone:', phone);
    
    // Check for user
    const [users] = await db.execute(
      'SELECT * FROM users WHERE phone = ?',
      [phone]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = users[0];

    // Check password
    const isPasswordMatch = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Remove password from response
    delete user.password_hash;

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user,
        token: generateToken(user.id)
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
};

// @desc    Forgot password - Step 1: Request reset code
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
  const { phone } = req.body;
  
  // Start transaction
  let connection;
  
  try {
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone number'
      });
    }

    // Validate phone number format
    if (!smsService.isValidPhoneNumber(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid phone number with country code (e.g., +919876543210)'
      });
    }

    console.log('🔍 Forgot password for phone:', phone);
    
    // Get a connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Check if user exists
    const [users] = await connection.execute(
      'SELECT id, name FROM users WHERE phone = ?',
      [phone]
    );

    // Generate 6-digit reset code
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Generate secure token for database storage
    const resetToken = crypto.randomBytes(32).toString('hex');
    
    // Hash token for database storage
    const hashedResetToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    
    // Set token expiry (15 minutes from now)
    const resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    
    // Only proceed if user exists
    if (users.length > 0) {
      const user = users[0];
      
      // Save reset token to database
      await connection.execute(
        'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
        [hashedResetToken, resetTokenExpiry, user.id]
      );

      // Initialize reset cache if not exists
      if (!global.resetCodesCache) global.resetCodesCache = {};
      
      // Store reset code in cache for verification
      global.resetCodesCache[phone] = {
        code: resetCode,
        token: resetToken, // Store the actual token for later verification
        expiresAt: resetTokenExpiry,
        attempts: 0,  // Track verification attempts
        createdAt: new Date()
      };

      // Send SMS via Twilio
      try {
        const smsResult = await smsService.sendResetCode(phone, resetCode, user.name);
        
        console.log(`✅ Reset code sent to ${phone} via ${smsResult.mode}`);
        
        // Log SMS details in development
        if (smsResult.mode === 'simulation') {
          console.log(`📱 Development Reset Code for ${phone}: ${resetCode}`);
          console.log(`📱 Cache Key: ${phone}`);
        }
        
      } catch (smsError) {
        console.error('❌ SMS sending failed:', smsError.message);
        
        // Rollback transaction since SMS failed
        await connection.rollback();
        connection.release();
        
        return res.status(500).json({
          success: false,
          message: smsError.message || 'Failed to send reset code. Please try again.'
        });
      }
    } else {
      // User doesn't exist, but we still "send" SMS in simulation mode
      // to maintain consistent timing (security measure)
      if (process.env.NODE_ENV === 'development' || process.env.SMS_ENABLED === 'false') {
        console.log(`📱 [SIMULATION] Would send reset code to non-existent user: ${phone}`);
      }
      
      // Simulate SMS delay
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Commit transaction
    await connection.commit();

    // Always return the same success message for security
    // (Don't reveal whether user exists or not)
    res.status(200).json({
      success: true,
      message: 'If an account exists with this number, a reset code has been sent.',
      // In development, include hint about simulation mode
      ...(process.env.NODE_ENV === 'development' && {
        hint: 'Check console for reset code in simulation mode'
      })
    });
  } catch (error) {
    console.error('❌ Forgot password error:', error);
    
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
      message: 'Server error processing forgot password request'
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

// @desc    Verify reset code - Step 2: Verify the 6-digit code
// @route   POST /api/auth/verify-reset-code
// @access  Public
const verifyResetCode = async (req, res) => {
  const { phone, code } = req.body;
  
  try {
    if (!phone || !code) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone number and reset code'
      });
    }

    // Validate phone number format
    if (!smsService.isValidPhoneNumber(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid phone number'
      });
    }

    console.log(`🔍 Verifying reset code for ${phone}: ${code}`);

    // Check if reset code exists in cache
    const resetData = global.resetCodesCache?.[phone];
    
    if (!resetData) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset code. Please request a new one.'
      });
    }
    
    // Check if code has expired
    if (new Date() > new Date(resetData.expiresAt)) {
      delete global.resetCodesCache[phone];
      return res.status(400).json({
        success: false,
        message: 'Reset code has expired. Please request a new one.'
      });
    }
    
    // Check verification attempts (prevent brute force)
    if (resetData.attempts >= 3) {
      delete global.resetCodesCache[phone];
      return res.status(400).json({
        success: false,
        message: 'Too many failed attempts. Please request a new code.'
      });
    }
    
    // Verify the code
    if (resetData.code !== code.toString()) { // Convert to string for comparison
      resetData.attempts += 1;
      global.resetCodesCache[phone] = resetData;
      
      const attemptsLeft = 3 - resetData.attempts;
      
      return res.status(400).json({
        success: false,
        message: `Invalid code. ${attemptsLeft} attempt(s) left.`,
        attemptsLeft: attemptsLeft
      });
    }
    
    // Code is valid - generate a verification token for password reset
    const verificationToken = crypto.randomBytes(32).toString('hex');
    
    // Update cache with verification status
    resetData.verified = true;
    resetData.verificationToken = verificationToken;
    resetData.verifiedAt = new Date();
    global.resetCodesCache[phone] = resetData;
    
    console.log(`✅ Reset code verified for ${phone}`);
    
    res.status(200).json({
      success: true,
      message: 'Code verified successfully',
      data: {
        verificationToken: verificationToken,
        expiresAt: resetData.expiresAt
      }
    });
    
  } catch (error) {
    console.error('❌ Verify reset code error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error verifying code'
    });
  }
};

// @desc    Reset password - Step 3: Reset password with verified token
// @route   POST /api/auth/reset-password
// @access  Public
const resetPassword = async (req, res) => {
  const { phone, verificationToken, newPassword } = req.body;
  
  // Start transaction
  let connection;
  
  try {
    if (!phone || !verificationToken || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone, verification token, and new password'
      });
    }

    // Validate phone number format
    if (!smsService.isValidPhoneNumber(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid phone number'
      });
    }

    // Validate password strength
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }

    console.log(`🔍 Resetting password for ${phone}`);

    // Verify the verification token from cache
    const resetData = global.resetCodesCache?.[phone];
    
    if (!resetData || 
        !resetData.verified || 
        resetData.verificationToken !== verificationToken) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification. Please start the reset process over.'
      });
    }
    
    // Check if verification has expired
    if (new Date() > new Date(resetData.expiresAt)) {
      delete global.resetCodesCache[phone];
      return res.status(400).json({
        success: false,
        message: 'Verification expired. Please request a new code.'
      });
    }
    
    // Get a connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Hash the reset token to compare with stored hash
    const hashedToken = crypto
      .createHash('sha256')
      .update(resetData.token)
      .digest('hex');

    // Find user with valid reset token
    const [users] = await connection.execute(
      'SELECT id, reset_token_expiry FROM users WHERE phone = ? AND reset_token = ?',
      [phone, hashedToken]
    );

    if (users.length === 0) {
      // Rollback transaction before returning error
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset session'
      });
    }

    const user = users[0];
    
    // Double-check token expiry in database
    if (new Date() > new Date(user.reset_token_expiry)) {
      // Rollback transaction before returning error
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'Reset session has expired'
      });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    
    // Update password and clear reset token
    await connection.execute(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
      [hashedPassword, user.id]
    );

    // Commit transaction
    await connection.commit();
    
    // Clean up the cache after successful reset
    delete global.resetCodesCache[phone];

    console.log(`✅ Password reset successful for ${phone}`);

    res.status(200).json({
      success: true,
      message: 'Password reset successful. You can now login with your new password.'
    });
  } catch (error) {
    console.error('❌ Reset password error:', error);
    
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
      message: 'Server error resetting password'
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

// @desc    Change password (authenticated user)
// @route   PUT /api/auth/change-password
// @access  Private
const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  // Start transaction
  let connection;
  
  try {
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide current and new password'
      });
    }

    // Validate new password strength
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long'
      });
    }

    // Get a connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Get user with current password
    const [users] = await connection.execute(
      'SELECT id, password_hash FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      // Rollback transaction before returning error
      await connection.rollback();
      connection.release();
      
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];

    // Verify current password
    const isPasswordMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isPasswordMatch) {
      // Rollback transaction before returning error
      await connection.rollback();
      connection.release();
      
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    
    // Update password
    await connection.execute(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [hashedPassword, user.id]
    );

    // Commit transaction
    await connection.commit();

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('❌ Change password error:', error);
    
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
      message: 'Server error changing password'
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

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res) => {
  try {
    const [users] = await db.execute(
      'SELECT id, name, phone, email, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: users[0]
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/update
// @access  Private
const updateProfile = async (req, res) => {
  const { name, email } = req.body;
  
  // Start transaction
  let connection;
  
  try {
    const updateFields = [];
    const values = [];

    if (name) {
      updateFields.push('name = ?');
      values.push(name);
    }

    if (email) {
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          message: 'Please provide a valid email address'
        });
      }
      updateFields.push('email = ?');
      values.push(email);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    values.push(req.user.id);

    // Get a connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Check if email is already taken by another user
    if (email) {
      const [existingEmail] = await connection.execute(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [email, req.user.id]
      );

      if (existingEmail.length > 0) {
        await connection.rollback();
        connection.release();
        
        return res.status(400).json({
          success: false,
          message: 'Email is already taken by another user'
        });
      }
    }

    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`;
    
    await connection.execute(query, values);

    // Commit transaction
    await connection.commit();

    // Get updated user with a new connection
    const [users] = await db.execute(
      'SELECT id, name, phone, email, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: users[0]
    });
  } catch (error) {
    console.error('Update profile error:', error);
    
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
      message: 'Server error'
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

// @desc    Check reset code status (for debugging/testing)
// @route   GET /api/auth/debug-reset-codes
// @access  Private (Development only)
const debugResetCodes = async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({
      success: false,
      message: 'Access denied'
    });
  }

  try {
    const codes = global.resetCodesCache || {};
    
    res.json({
      success: true,
      data: {
        totalCodes: Object.keys(codes).length,
        codes: codes
      }
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({
      success: false,
      message: 'Debug error'
    });
  }
};

// @desc    Clear expired reset codes (cleanup)
// @route   POST /api/auth/cleanup-reset-codes
// @access  Private (Admin/Development)
const cleanupResetCodes = async (req, res) => {
  try {
    if (!global.resetCodesCache) {
      return res.json({
        success: true,
        message: 'No reset codes to clean up',
        cleaned: 0
      });
    }

    const now = new Date();
    let cleanedCount = 0;
    const codes = global.resetCodesCache;

    // Clean expired codes
    for (const [phone, data] of Object.entries(codes)) {
      if (now > new Date(data.expiresAt)) {
        delete codes[phone];
        cleanedCount++;
      }
    }

    global.resetCodesCache = codes;

    res.json({
      success: true,
      message: `Cleaned up ${cleanedCount} expired reset codes`,
      cleaned: cleanedCount,
      remaining: Object.keys(codes).length
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      success: false,
      message: 'Cleanup error'
    });
  }
};

module.exports = {
  register,
  login,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  changePassword,
  getMe,
  updateProfile,
  debugResetCodes,
  cleanupResetCodes
};