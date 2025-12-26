// TOP OF THE FILE
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

// Helper: Normalize phone number
const normalizePhone = (phone) => {
  if (!phone) return null;
  
  // Remove all non-digit characters except +
  let normalized = phone.replace(/[^\d+]/g, '');
  
  // Ensure it starts with +
  if (!normalized.startsWith('+')) {
    // Remove leading zeros and add +254 for Kenya
    normalized = normalized.replace(/^0+/, '');
    
    // Add country code
    const defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || '254';
    
    // Check if already has country code
    if (!normalized.startsWith(defaultCountryCode)) {
      normalized = `+${defaultCountryCode}${normalized}`;
    } else {
      normalized = `+${normalized}`;
    }
  }
  
  return normalized;
};

// Initialize global cache
if (!global.resetTokensCache) global.resetTokensCache = {};
if (!global.testOTPs) global.testOTPs = {};

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

    // Normalize phone number
    const normalizedPhone = normalizePhone(phone);
    console.log('Normalized phone:', normalizedPhone);

    if (!normalizedPhone || !smsService.isValidPhoneNumber(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid phone number with country code (e.g., +254799860103)'
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

    console.log('🔍 Checking if user exists:', normalizedPhone);
    
    // Check if user exists
    const [existingUsers] = await connection.execute(
      'SELECT id FROM users WHERE phone = ? OR email = ?',
      [normalizedPhone, email || '']
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
    console.log('🔍 Password hashed successfully');

    // Insert user
    console.log('🔍 Inserting new user');
    const [result] = await connection.execute(
      'INSERT INTO users (name, phone, email, password_hash) VALUES (?, ?, ?, ?)',
      [name, normalizedPhone, email || null, hashedPassword]
    );

    console.log('🔍 User inserted with ID:', result.insertId);

    // Commit transaction
    console.log('🔍 Committing transaction');
    await connection.commit();

    // Send welcome SMS (non-blocking)
    try {
      const smsResult = await smsService.sendWelcomeMessage(normalizedPhone, name);
      console.log(`✅ Welcome SMS sent to ${normalizedPhone}: ${smsResult.messageId}`);
    } catch (smsError) {
      console.warn('⚠️ Welcome SMS failed to send:', smsError.message);
    }

    // Get created user
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

    // Normalize phone number
    const normalizedPhone = normalizePhone(phone);
    console.log('🔍 Checking for user with phone:', normalizedPhone);
    
    // Check for user
    const [users] = await db.execute(
      'SELECT * FROM users WHERE phone = ?',
      [normalizedPhone]
    );

    console.log('🔍 Users found:', users.length);

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = users[0];
    console.log('🔍 User found:', { id: user.id, name: user.name });

    // Check password
    console.log('🔍 Comparing password...');
    const isPasswordMatch = await bcrypt.compare(password, user.password_hash);
    console.log('🔍 Password match:', isPasswordMatch);
    
    if (!isPasswordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Remove password from response
    const { password_hash, reset_token, reset_token_expiry, ...userData } = user;

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: userData,
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

// @desc    Forgot password - Step 1: Request OTP via Twilio Verify
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
  const { phone } = req.body;
  
  // Start transaction
  let connection;
  
  try {
    console.log('=== FORGOT PASSWORD START ===');
    
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone number'
      });
    }

    // Normalize phone number
    const normalizedPhone = normalizePhone(phone);
    console.log('🔍 Forgot password for phone:', normalizedPhone);

    if (!normalizedPhone || !smsService.isValidPhoneNumber(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid phone number with country code (e.g., +254799860103)'
      });
    }
    
    // Get a connection for transaction
    connection = await db.getConnection();
    
    // Start transaction
    await connection.beginTransaction();

    // Check if user exists
    const [users] = await connection.execute(
      'SELECT id, name FROM users WHERE phone = ?',
      [normalizedPhone]
    );

    console.log('🔍 User exists:', users.length > 0);

    // Generate secure token for database storage
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedResetToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    
    // Set token expiry (15 minutes from now)
    const resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);
    
    // Only proceed if user exists
    if (users.length > 0) {
      const user = users[0];
      
      console.log('🔍 Saving reset token to database for user:', user.id);
      
      // Save reset token to database
      await connection.execute(
        'UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
        [hashedResetToken, resetTokenExpiry, user.id]
      );

      // Send OTP via Twilio Verify API
      try {
        console.log('🔍 Sending OTP via Twilio Verify...');
        const smsResult = await smsService.sendVerificationCode(normalizedPhone, 'sms');
        
        console.log(`✅ OTP requested for ${normalizedPhone} via ${smsResult.mode}`);
        
        // Store reset token in cache for later verification
        global.resetTokensCache[normalizedPhone] = {
          token: resetToken,
          expiresAt: resetTokenExpiry,
          attempts: 0,
          createdAt: new Date(),
          userId: user.id,
          phone: normalizedPhone
        };
        
        console.log('🔍 Reset token stored in cache');
        
        // In development/simulation mode, include debug info
        if (smsResult.mode === 'simulation' && smsResult.debugCode) {
          console.log(`📱 DEVELOPMENT OTP for ${normalizedPhone}: ${smsResult.debugCode}`);
          console.log(`📱 Use this code in verify-reset-code endpoint`);
          
          // Store for testing
          global.testOTPs[normalizedPhone] = smsResult.debugCode;
        }
        
      } catch (smsError) {
        console.error('❌ OTP request failed:', smsError.message);
        
        // Rollback transaction since OTP request failed
        await connection.rollback();
        connection.release();
        
        return res.status(500).json({
          success: false,
          message: smsError.message || 'Failed to send OTP. Please try again.'
        });
      }
    } else {
      console.log(`📱 User not found for ${normalizedPhone}, simulating for security`);
      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Commit transaction
    await connection.commit();
    console.log('✅ Transaction committed');

    // Always return the same success message for security
    const response = {
      success: true,
      message: 'If an account exists with this number, an OTP has been sent.'
    };
    
    // Development hint
    if (process.env.NODE_ENV === 'development' && global.testOTPs[normalizedPhone]) {
      response.development = {
        note: 'In development mode - OTP available in console',
        phone: normalizedPhone
      };
    }
    
    res.status(200).json(response);
    
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

// @desc    Verify OTP - Step 2: Verify the OTP from Twilio Verify
// @route   POST /api/auth/verify-reset-code
// @access  Public
const verifyResetCode = async (req, res) => {
  const { phone, code } = req.body;
  
  try {
    console.log('=== VERIFY RESET CODE START ===');
    
    if (!phone || !code) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone number and OTP'
      });
    }

    // Normalize phone number
    const normalizedPhone = normalizePhone(phone);
    console.log(`🔍 Verifying OTP for ${normalizedPhone}: ${code}`);

    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid phone number'
      });
    }

    // Verify OTP using Twilio Verify API
    try {
      console.log('🔍 Calling Twilio Verify API...');
      const verificationResult = await smsService.verifyCode(normalizedPhone, code);
      
      console.log('🔍 Verification result:', verificationResult);
      
      if (!verificationResult.valid) {
        return res.status(400).json({
          success: false,
          message: verificationResult.message || 'Invalid OTP'
        });
      }
      
      console.log(`✅ OTP verified successfully for ${normalizedPhone}`);
      
      // Check if we have a reset token for this phone
      const resetData = global.resetTokensCache[normalizedPhone];
      
      if (!resetData) {
        console.log('❌ No reset token found in cache for:', normalizedPhone);
        return res.status(400).json({
          success: false,
          message: 'No password reset request found. Please start over.'
        });
      }
      
      // Check if token has expired
      if (new Date() > new Date(resetData.expiresAt)) {
        delete global.resetTokensCache[normalizedPhone];
        console.log('❌ Reset token expired for:', normalizedPhone);
        return res.status(400).json({
          success: false,
          message: 'Reset request has expired. Please request a new OTP.'
        });
      }
      
      // Generate a verification token for password reset
      const verificationToken = crypto.randomBytes(32).toString('hex');
      
      // Update cache with verification status
      resetData.verified = true;
      resetData.verificationToken = verificationToken;
      resetData.verifiedAt = new Date();
      global.resetTokensCache[normalizedPhone] = resetData;
      
      console.log('✅ Verification token generated:', verificationToken.substring(0, 20) + '...');
      
      res.status(200).json({
        success: true,
        message: 'OTP verified successfully',
        data: {
          verificationToken: verificationToken,
          expiresAt: resetData.expiresAt
        }
      });
      
    } catch (verifyError) {
      console.error('❌ OTP verification error:', verifyError.message);
      
      return res.status(400).json({
        success: false,
        message: verifyError.message || 'OTP verification failed'
      });
    }
    
  } catch (error) {
    console.error('❌ Verify reset code error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error verifying OTP'
    });
  }
};

// @desc    Reset password - Step 3: Reset password after OTP verification
// @route   POST /api/auth/reset-password
// @access  Public
const resetPassword = async (req, res) => {
  const { phone, verificationToken, newPassword } = req.body;
  
  // Start transaction
  let connection;
  
  try {
    console.log('=== RESET PASSWORD START ===');
    console.log('Phone:', phone);
    console.log('Verification Token:', verificationToken?.substring(0, 20) + '...');
    console.log('New Password Length:', newPassword?.length);

    // Validate input
    if (!phone || !verificationToken || !newPassword) {
      console.log('❌ Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'Please provide phone, verification token, and new password'
      });
    }

    // Normalize phone number
    const normalizedPhone = normalizePhone(phone);
    console.log('Normalized Phone:', normalizedPhone);

    if (!normalizedPhone) {
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

    // Check cache
    const resetData = global.resetTokensCache[normalizedPhone];
    console.log('Cache entry found:', !!resetData);
    
    if (!resetData) {
      return res.status(400).json({
        success: false,
        message: 'No password reset request found. Please start over.'
      });
    }

    console.log('Cache data:', {
      verified: resetData.verified,
      verificationTokenMatch: resetData.verificationToken === verificationToken,
      expiresAt: resetData.expiresAt,
      verifiedAt: resetData.verifiedAt
    });

    // Verify the verification token
    if (!resetData.verified || resetData.verificationToken !== verificationToken) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired verification token'
      });
    }
    
    // Check if verification has expired (15 minutes)
    if (new Date() > new Date(resetData.expiresAt)) {
      delete global.resetTokensCache[normalizedPhone];
      return res.status(400).json({
        success: false,
        message: 'Reset session has expired. Please request a new OTP.'
      });
    }
    
    // Get database connection for transaction
    console.log('🔍 Getting database connection...');
    connection = await db.getConnection();
    
    // Start transaction
    console.log('🔍 Starting transaction...');
    await connection.beginTransaction();

    // Hash the reset token to compare with stored hash
    const hashedResetToken = crypto
      .createHash('sha256')
      .update(resetData.token)
      .digest('hex');
    
    console.log('🔍 Looking for user with reset token...');
    
    // Find user with valid reset token
    const [users] = await connection.execute(
      'SELECT id, password_hash, reset_token, reset_token_expiry FROM users WHERE phone = ? AND reset_token = ?',
      [normalizedPhone, hashedResetToken]
    );

    console.log('🔍 Users found with reset token:', users.length);
    
    if (users.length === 0) {
      console.log('❌ No user found with matching reset token');
      
      // Also check user exists at all
      const [allUsers] = await connection.execute(
        'SELECT id FROM users WHERE phone = ?',
        [normalizedPhone]
      );
      console.log('🔍 Total users with this phone:', allUsers.length);
      
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'Invalid reset session. Please start over.'
      });
    }

    const user = users[0];
    console.log('🔍 User ID:', user.id);
    console.log('🔍 Current reset token expiry in DB:', user.reset_token_expiry);
    
    // Double-check token expiry in database
    if (new Date() > new Date(user.reset_token_expiry)) {
      await connection.rollback();
      connection.release();
      
      delete global.resetTokensCache[normalizedPhone];
      
      return res.status(400).json({
        success: false,
        message: 'Reset session has expired'
      });
    }

    // Check if new password is same as old password
    console.log('🔍 Checking if new password is same as old...');
    const isSamePassword = await bcrypt.compare(newPassword, user.password_hash);
    
    if (isSamePassword) {
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'New password cannot be the same as old password'
      });
    }

    // Hash new password
    console.log('🔍 Hashing new password...');
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    console.log('🔍 New password hashed');

    // Update password and clear reset token
    console.log('🔍 Updating password in database...');
    const [updateResult] = await connection.execute(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
      [hashedPassword, user.id]
    );
    
    console.log('🔍 Update affected rows:', updateResult.affectedRows);

    // Verify the update
    const [updatedUser] = await connection.execute(
      'SELECT password_hash FROM users WHERE id = ?',
      [user.id]
    );
    
    console.log('🔍 Password updated successfully');
    console.log('🔍 New hash in DB:', updatedUser[0].password_hash.substring(0, 20) + '...');

    // Commit transaction
    console.log('🔍 Committing transaction...');
    await connection.commit();
    
    // Clean up cache
    delete global.resetTokensCache[normalizedPhone];
    if (global.testOTPs && global.testOTPs[normalizedPhone]) {
      delete global.testOTPs[normalizedPhone];
    }
    
    console.log('✅ Password reset completed successfully');

    res.status(200).json({
      success: true,
      message: 'Password reset successful. You can now login with your new password.',
      data: {
        phone: normalizedPhone,
        resetAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Reset password error:', error);
    
    // Rollback transaction in case of error
    if (connection) {
      try {
        console.log('🔍 Rolling back transaction...');
        await connection.rollback();
      } catch (rollbackError) {
        console.error('❌ Rollback error:', rollbackError);
      } finally {
        connection.release();
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Server error resetting password',
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
      await connection.rollback();
      connection.release();
      
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Check if new password is same as current
    if (currentPassword === newPassword) {
      await connection.rollback();
      connection.release();
      
      return res.status(400).json({
        success: false,
        message: 'New password cannot be the same as current password'
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

    // Check if email is already taken
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

    // Get updated user
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
    if (connection && connection.release) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error('❌ Connection release error:', releaseError);
      }
    }
  }
};

// @desc    Debug user password (development only)
// @route   GET /api/auth/debug-user/:phone
// @access  Development only
const debugUserPassword = async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  try {
    const { phone } = req.params;
    const normalizedPhone = normalizePhone(phone);
    
    const [users] = await db.execute(
      'SELECT id, phone, password_hash, reset_token, reset_token_expiry, created_at FROM users WHERE phone = ?',
      [normalizedPhone]
    );

    if (users.length === 0) {
      return res.json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];
    
    // Test common passwords
    const testPasswords = [
      'NewSecurePassword456!',
      'test123',
      'password',
      '123456'
    ];
    
    const passwordTests = {};
    for (const password of testPasswords) {
      try {
        const match = await bcrypt.compare(password, user.password_hash);
        passwordTests[password] = match ? '✅ MATCHES' : '❌ NO MATCH';
      } catch (error) {
        passwordTests[password] = '❌ ERROR: ' + error.message;
      }
    }

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          phone: user.phone,
          has_password: !!user.password_hash,
          password_length: user.password_hash ? user.password_hash.length : 0,
          reset_token: user.reset_token ? 'Present' : 'None',
          reset_token_expiry: user.reset_token_expiry,
          created_at: user.created_at
        },
        passwordTests,
        hash_sample: user.password_hash ? user.password_hash.substring(0, 30) + '...' : null,
        cache_status: global.resetTokensCache[normalizedPhone] ? 'Present' : 'Not in cache'
      }
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ success: false, message: 'Debug error' });
  }
};

// @desc    Debug reset tokens cache
// @route   GET /api/auth/debug-reset-tokens
// @access  Development only
const debugResetTokens = async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  try {
    const cache = global.resetTokensCache || {};
    const now = new Date();
    
    const formattedCache = {};
    for (const [phone, data] of Object.entries(cache)) {
      formattedCache[phone] = {
        ...data,
        token: data.token?.substring(0, 10) + '...',
        verificationToken: data.verificationToken?.substring(0, 10) + '...',
        isExpired: now > new Date(data.expiresAt),
        ageMinutes: Math.round((now - new Date(data.createdAt)) / (60 * 1000)),
        verified: data.verified || false
      };
    }
    
    res.json({
      success: true,
      data: {
        totalEntries: Object.keys(cache).length,
        cache: formattedCache,
        testOTPs: global.testOTPs || {}
      }
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ success: false, message: 'Debug error' });
  }
};

// @desc    Test login with specific password
// @route   POST /api/auth/test-login
// @access  Development only
const testLogin = async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  try {
    const { phone, password } = req.body;
    
    if (!phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone and password'
      });
    }

    const normalizedPhone = normalizePhone(phone);
    
    const [users] = await db.execute(
      'SELECT * FROM users WHERE phone = ?',
      [normalizedPhone]
    );

    if (users.length === 0) {
      return res.json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];
    const isPasswordMatch = await bcrypt.compare(password, user.password_hash);
    
    res.json({
      success: true,
      data: {
        userFound: true,
        userId: user.id,
        passwordMatch: isPasswordMatch,
        passwordHash: user.password_hash.substring(0, 30) + '...'
      }
    });
  } catch (error) {
    console.error('Test login error:', error);
    res.status(500).json({ success: false, message: 'Test error' });
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
  debugUserPassword,
  debugResetTokens,
  testLogin
};