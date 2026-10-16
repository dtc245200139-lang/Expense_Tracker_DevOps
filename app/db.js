/**
 * Module kết nối cơ sở dữ liệu PostgreSQL
 * Sử dụng connection pool từ thư viện 'pg'
 */
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config();

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    user: process.env.DB_USER || 'expense_user',
    password: process.env.DB_PASSWORD || 'expense_pass_secure_123',
    database: process.env.DB_NAME || 'expense_tracker_db',
    max: 20, // Số kết nối tối đa trong pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
    // console.log('✅ Đã tạo kết nối mới tới PostgreSQL');
});

pool.on('error', (err) => {
    console.error('❌ Lỗi bất ngờ trên PostgreSQL connection pool:', err.message);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool,
};
