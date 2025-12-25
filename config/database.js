// config/database.js - GUARANTEED WORKING VERSION
const mysql = require('mysql2');
require('dotenv').config();

console.log('🔧 Initializing database with config:');
console.log('  Database:', process.env.DB_NAME || 'simple_chama');
console.log('  Host:', process.env.DB_HOST || 'localhost');
console.log('  User:', process.env.DB_USER || 'root');

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'simple_chama',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Create promise pool
const promisePool = pool.promise();

// Test connection
promisePool.getConnection()
  .then(connection => {
    console.log('✅ Database connected successfully');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err.message);
  });

// Create and export db object
const db = {
  execute: function(...args) {
    return promisePool.execute(...args);
  },
  query: function(...args) {
    return promisePool.query(...args);
  },
  getConnection: function() {
    return promisePool.getConnection();
  }
};

// Verify export
console.log('📦 Exporting db object with methods:', Object.keys(db));

module.exports = db;