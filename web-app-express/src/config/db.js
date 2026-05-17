const mysql = require('mysql2/promise');

const dbConfig = {
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'user_app',
  password: process.env.DB_PASS || 'password_app',
  database: process.env.DB_NAME || 'unimq',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4_general_ci'
};

const pool = mysql.createPool(dbConfig);

module.exports = { pool, dbConfig };
