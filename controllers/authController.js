// TOP OF THE FILE - Add this debugging
console.log('🔍 authController: Loading database...');
const db = require('../config/database');
console.log('🔍 authController: db loaded, has execute?', typeof db.execute === 'function');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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

  try {
    // Validate required fields
    if (!name || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, phone and password'
      });
    }

    console.log('🔍 Checking if user exists:', phone);
    
    // Check if user exists
    const [existingUsers] = await db.execute(
      'SELECT id FROM users WHERE phone = ? OR email = ?',
      [phone, email || '']
    );

    if (existingUsers.length > 0) {
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
    const [result] = await db.execute(
      'INSERT INTO users (name, phone, email, password_hash) VALUES (?, ?, ?, ?)',
      [name, phone, email || null, hashedPassword]
    );

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
    res.status(500).json({
      success: false,
      message: 'Server error during registration',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
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

  try {
    const updateFields = [];
    const values = [];

    if (name) {
      updateFields.push('name = ?');
      values.push(name);
    }

    if (email) {
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

    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`;
    
    await db.execute(query, values);

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
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

module.exports = {
  register,
  login,
  getMe,
  updateProfile
};