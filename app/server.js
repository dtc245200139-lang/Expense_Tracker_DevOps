/**
 * ==============================================================================
 * HỆ THỐNG QUẢN LÝ CHI TIÊU (EXPENSE TRACKER) - EXPRESS SERVER
 * ==============================================================================
 */

const express = require('express');
const path = require('path');
const methodOverride = require('method-override');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config(); // Fallback nếu chạy trực tiếp trong thư mục app

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Cấu hình View Engine EJS
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Middlewares
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// Helper định dạng tiền tệ Việt Nam (VNĐ) và ngày tháng
app.locals.formatCurrency = (amount) => {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
};

app.locals.formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

// ==============================================================================
// 1. HEALTHCHECK ENDPOINT (Dùng cho Docker & Giám sát)
// ==============================================================================
app.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.status(200).json({ status: 'UP', database: 'connected', timestamp: new Date() });
    } catch (err) {
        res.status(500).json({ status: 'DOWN', database: err.message, timestamp: new Date() });
    }
});

// ==============================================================================
// 2. TRANG CHỦ / DASHBOARD (Tổng quan thu - chi - số dư)
// ==============================================================================
app.get('/', async (req, res) => {
    try {
        // 1. Tính tổng thu, tổng chi và số dư
        const summaryResult = await db.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
            FROM transactions
        `);
        const totalIncome = parseFloat(summaryResult.rows[0].total_income);
        const totalExpense = parseFloat(summaryResult.rows[0].total_expense);
        const netBalance = totalIncome - totalExpense;

        // 2. Lấy 6 giao dịch gần nhất
        const recentResult = await db.query(`
            SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
            FROM transactions t
            LEFT JOIN categories c ON t.category_id = c.id
            ORDER BY t.transaction_date DESC, t.id DESC
            LIMIT 6
        `);

        // 3. Lấy top 5 danh mục chi tiêu nhiều nhất
        const topExpensesResult = await db.query(`
            SELECT c.name, c.color, c.icon, SUM(t.amount) AS total_amount
            FROM transactions t
            JOIN categories c ON t.category_id = c.id
            WHERE t.type = 'expense'
            GROUP BY c.id, c.name, c.color, c.icon
            ORDER BY total_amount DESC
            LIMIT 5
        `);

        // 4. Lấy danh sách danh mục để phục vụ modal thêm nhanh
        const categoriesResult = await db.query('SELECT * FROM categories ORDER BY name ASC');

        res.render('index', {
            title: 'Tổng quan chi tiêu',
            totalIncome,
            totalExpense,
            netBalance,
            recentTransactions: recentResult.rows,
            topExpenses: topExpensesResult.rows,
            categories: categoriesResult.rows,
            activePage: 'dashboard'
        });
    } catch (err) {
        console.error('Lỗi tải Dashboard:', err);
        res.status(500).send('Lỗi máy chủ khi tải trang tổng quan: ' + err.message);
    }
});

// ==============================================================================
// 3. QUẢN LÝ GIAO DỊCH (DANH SÁCH, LỌC, TÌM KIẾM)
// ==============================================================================
app.get('/transactions', async (req, res) => {
    try {
        const { type, category_id, start_date, end_date, search } = req.query;

        let queryText = `
            SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
            FROM transactions t
            LEFT JOIN categories c ON t.category_id = c.id
            WHERE 1=1
        `;
        const params = [];

        if (type && (type === 'income' || type === 'expense')) {
            params.push(type);
            queryText += ` AND t.type = $${params.length}`;
        }

        if (category_id && !isNaN(parseInt(category_id))) {
            params.push(parseInt(category_id));
            queryText += ` AND t.category_id = $${params.length}`;
        }

        if (start_date) {
            params.push(start_date);
            queryText += ` AND t.transaction_date >= $${params.length}`;
        }

        if (end_date) {
            params.push(end_date);
            queryText += ` AND t.transaction_date <= $${params.length}`;
        }

        if (search && search.trim() !== '') {
            params.push(`%${search.trim()}%`);
            queryText += ` AND (t.title ILIKE $${params.length} OR t.notes ILIKE $${params.length})`;
        }

        queryText += ' ORDER BY t.transaction_date DESC, t.id DESC';

        const transactionsResult = await db.query(queryText, params);
        const categoriesResult = await db.query('SELECT * FROM categories ORDER BY type DESC, name ASC');

        res.render('transactions', {
            title: 'Danh sách giao dịch',
            transactions: transactionsResult.rows,
            categories: categoriesResult.rows,
            filters: { type, category_id, start_date, end_date, search },
            activePage: 'transactions'
        });
    } catch (err) {
        console.error('Lỗi tải danh sách giao dịch:', err);
        res.status(500).send('Lỗi tải giao dịch: ' + err.message);
    }
});

// THÊM GIAO DỊCH MỚI
app.post('/transactions', async (req, res) => {
    try {
        const { title, amount, type, category_id, transaction_date, notes } = req.body;
        
        if (!title || !amount || !type) {
            return res.status(400).send('Vui lòng điền đầy đủ tiêu đề, số tiền và loại giao dịch.');
        }

        await db.query(`
            INSERT INTO transactions (title, amount, type, category_id, transaction_date, notes)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [
            title.trim(),
            parseFloat(amount),
            type,
            category_id ? parseInt(category_id) : null,
            transaction_date || new Date().toISOString().split('T')[0],
            notes ? notes.trim() : null
        ]);

        res.redirect('/transactions');
    } catch (err) {
        console.error('Lỗi tạo giao dịch:', err);
        res.status(500).send('Không thể thêm giao dịch: ' + err.message);
    }
});

// TRANG SỬA GIAO DỊCH
app.get('/transactions/:id/edit', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const transactionResult = await db.query('SELECT * FROM transactions WHERE id = $1', [id]);
        
        if (transactionResult.rows.length === 0) {
            return res.status(404).send('Không tìm thấy giao dịch yêu cầu.');
        }

        const categoriesResult = await db.query('SELECT * FROM categories ORDER BY type DESC, name ASC');

        res.render('transaction_edit', {
            title: 'Chỉnh sửa giao dịch',
            transaction: transactionResult.rows[0],
            categories: categoriesResult.rows,
            activePage: 'transactions'
        });
    } catch (err) {
        console.error('Lỗi tải trang sửa giao dịch:', err);
        res.status(500).send('Lỗi máy chủ: ' + err.message);
    }
});

// CẬP NHẬT GIAO DỊCH
app.post('/transactions/:id/update', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { title, amount, type, category_id, transaction_date, notes } = req.body;

        await db.query(`
            UPDATE transactions
            SET title = $1, amount = $2, type = $3, category_id = $4, transaction_date = $5, notes = $6, updated_at = CURRENT_TIMESTAMP
            WHERE id = $7
        `, [
            title.trim(),
            parseFloat(amount),
            type,
            category_id ? parseInt(category_id) : null,
            transaction_date,
            notes ? notes.trim() : null,
            id
        ]);

        res.redirect('/transactions');
    } catch (err) {
        console.error('Lỗi cập nhật giao dịch:', err);
        res.status(500).send('Không thể cập nhật giao dịch: ' + err.message);
    }
});

// XÓA GIAO DỊCH
app.post('/transactions/:id/delete', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await db.query('DELETE FROM transactions WHERE id = $1', [id]);
        res.redirect('/transactions');
    } catch (err) {
        console.error('Lỗi xóa giao dịch:', err);
        res.status(500).send('Không thể xóa giao dịch: ' + err.message);
    }
});

// ==============================================================================
// 4. QUẢN LÝ DANH MỤC THU / CHI
// ==============================================================================
app.get('/categories', async (req, res) => {
    try {
        const categoriesResult = await db.query(`
            SELECT c.*, COUNT(t.id) AS transaction_count, COALESCE(SUM(t.amount), 0) AS total_amount
            FROM categories c
            LEFT JOIN transactions t ON c.id = t.category_id
            GROUP BY c.id
            ORDER BY c.type DESC, c.name ASC
        `);

        res.render('categories', {
            title: 'Quản lý danh mục',
            categories: categoriesResult.rows,
            activePage: 'categories'
        });
    } catch (err) {
        console.error('Lỗi tải danh mục:', err);
        res.status(500).send('Lỗi máy chủ khi tải danh mục: ' + err.message);
    }
});

// THÊM DANH MỤC MỚI
app.post('/categories', async (req, res) => {
    try {
        const { name, type, icon, color } = req.body;
        if (!name || !type) {
            return res.status(400).send('Tên danh mục và loại là bắt buộc.');
        }

        await db.query(`
            INSERT INTO categories (name, type, icon, color)
            VALUES ($1, $2, $3, $4)
        `, [
            name.trim(),
            type,
            icon ? icon.trim() : 'bi-tag',
            color || '#0d6efd'
        ]);

        res.redirect('/categories');
    } catch (err) {
        console.error('Lỗi thêm danh mục:', err);
        res.status(500).send('Không thể thêm danh mục: ' + err.message);
    }
});

// XÓA DANH MỤC
app.post('/categories/:id/delete', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        // Do bảng transactions có category_id REFERENCES categories(id) ON DELETE SET NULL,
        // khi xóa danh mục, các giao dịch liên quan sẽ chuyển về Không phân loại (NULL)
        await db.query('DELETE FROM categories WHERE id = $1', [id]);
        res.redirect('/categories');
    } catch (err) {
        console.error('Lỗi xóa danh mục:', err);
        res.status(500).send('Không thể xóa danh mục: ' + err.message);
    }
});

// ==============================================================================
// 5. TRANG BÁO CÁO & THỐNG KÊ CHI TIẾT
// ==============================================================================
app.get('/reports', async (req, res) => {
    try {
        // 1. Tổng quát
        const summary = await db.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense,
                COUNT(*) AS total_transactions
            FROM transactions
        `);
        const totalIncome = parseFloat(summary.rows[0].total_income);
        const totalExpense = parseFloat(summary.rows[0].total_expense);
        const netBalance = totalIncome - totalExpense;
        const totalTransactions = parseInt(summary.rows[0].total_transactions);

        // 2. Thống kê theo Danh mục chi tiêu
        const expenseByCategory = await db.query(`
            SELECT 
                c.name, c.color, c.icon,
                SUM(t.amount) AS total_amount,
                COUNT(t.id) AS count
            FROM transactions t
            JOIN categories c ON t.category_id = c.id
            WHERE t.type = 'expense'
            GROUP BY c.id, c.name, c.color, c.icon
            ORDER BY total_amount DESC
        `);

        // 3. Thống kê theo Danh mục thu nhập
        const incomeByCategory = await db.query(`
            SELECT 
                c.name, c.color, c.icon,
                SUM(t.amount) AS total_amount,
                COUNT(t.id) AS count
            FROM transactions t
            JOIN categories c ON t.category_id = c.id
            WHERE t.type = 'income'
            GROUP BY c.id, c.name, c.color, c.icon
            ORDER BY total_amount DESC
        `);

        // 4. Thống kê theo tháng gần đây
        const monthlyStats = await db.query(`
            SELECT 
                TO_CHAR(transaction_date, 'YYYY-MM') AS month_year,
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS month_income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS month_expense
            FROM transactions
            GROUP BY month_year
            ORDER BY month_year DESC
            LIMIT 12
        `);

        res.render('reports', {
            title: 'Báo cáo tài chính',
            totalIncome,
            totalExpense,
            netBalance,
            totalTransactions,
            expenseByCategory: expenseByCategory.rows,
            incomeByCategory: incomeByCategory.rows,
            monthlyStats: monthlyStats.rows,
            activePage: 'reports'
        });
    } catch (err) {
        console.error('Lỗi tải báo cáo:', err);
        res.status(500).send('Lỗi máy chủ khi tải báo cáo: ' + err.message);
    }
});

// Khởi động Web Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 EXPENSE TRACKER WEB APP ĐANG CHẠY!`);
    console.log(`📍 Địa chỉ: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
