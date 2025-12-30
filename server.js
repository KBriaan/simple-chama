// const express = require('express');
// const cors = require('cors');
// require('dotenv').config();
// const db = require('./config/database');

// const app = express();

// // Middleware
// app.use(cors());
// app.use(express.json());

// // Test database connection
// db.getConnection((err, connection) => {
//   if (err) {
//     console.error('Error connecting to MySQL:', err.message);
//   } else {
//     console.log('Connected to MySQL database');
//     connection.release();
//   }
// });

// // Routes
// app.get('/', (req, res) => {
//   res.json({
//     message: 'Simple Chama API',
//     version: '1.0.0',
//     endpoints: {
//       auth: '/api/auth',
//       chamas: '/api/chamas',
//       contributions: '/api/contributions',
//       payouts: '/api/payouts',
//       reports: '/api/reports',
//       notifications: '/api/notifications'
//     }
//   });
// });

// // Import routes
// const authRoutes = require('./routes/auth');
// const chamaRoutes = require('./routes/chamas');
// const contributionRoutes = require('./routes/contributions');
// const payoutRoutes = require('./routes/payouts');
// const reportRoutes = require('./routes/reports');
// const notificationRoutes = require('./routes/notifications');

// app.use('/api/auth', authRoutes);
// app.use('/api/chamas', chamaRoutes);
// app.use('/api/contributions', contributionRoutes);
// app.use('/api/payouts', payoutRoutes);
// app.use('/api/reports', reportRoutes);
// app.use('/api/notifications', notificationRoutes);

// // Error handling middleware
// app.use((err, req, res, next) => {
//   console.error(err.stack);
//   res.status(500).json({
//     success: false,
//     message: 'Something went wrong!',
//     error: process.env.NODE_ENV === 'development' ? err.message : {}
//   });
// });

// // 404 handler
// app.use((req, res) => {
//   res.status(404).json({
//     success: false,
//     message: 'Endpoint not found'
//   });
// });

// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
//   console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
// });
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { pool } = require('./config/database');
const cron = require('node-cron');
const axios = require('axios');
const app = express();
cron.schedule('0 2 * * *', async () => {
  console.log('🔄 Running scheduled overdue cycles check...');
  
  try {
    // Call the check-overdue endpoint
    const response = await axios.get('http://localhost:5000/api/chamas/check-overdue', {
      headers: {
        'Authorization': `Bearer ${process.env.CRON_SECRET}`
      }
    });
    
    console.log('✅ Overdue cycles check completed:', response.data.message);
    console.log('Results:', JSON.stringify(response.data.data, null, 2));
  } catch (error) {
    console.error('❌ Cron job failed:', error.message);
  }
});

// Or run the function directly without API call
cron.schedule('0 2 * * *', async () => {
  console.log('🔄 Running direct overdue cycles check...');
  
  try {
    // You would need to import the function and call it directly
    // await checkOverdueCycles();
    console.log('✅ Direct check completed');
  } catch (error) {
    console.error('❌ Direct check failed:', error);
  }
});
// Middleware
app.use(cors());
app.use(express.json());

// Test database connection
const testDatabaseConnection = async () => {
  try {
    const connection = await pool.getConnection();
    console.log('Connected to MySQL database');
    connection.release();
  } catch (err) {
    console.error('Error connecting to MySQL:', err.message);
  }
};

testDatabaseConnection();

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Simple Chama API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      chamas: '/api/chamas',
      contributions: '/api/contributions',
      payouts: '/api/payouts',
      reports: '/api/reports',
      notifications: '/api/notifications'
    }
  });
});

// Import routes
const authRoutes = require('./routes/auth');
const chamaRoutes = require('./routes/chamas');
const contributionRoutes = require('./routes/contributions');
const payoutRoutes = require('./routes/payouts');
const reportRoutes = require('./routes/reports');
const notificationRoutes = require('./routes/notifications');
app.use('/api/auth', authRoutes);
app.use('/api/chamas', chamaRoutes);
app.use('/api/contributions', contributionRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/notifications', notificationRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : {}
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});