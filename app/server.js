/**
 * ==============================================================================
 * HỆ THỐNG QUẢN LÝ CHI TIÊU (EXPENSE TRACKER) - EXPRESS SERVER
 * ==============================================================================
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const methodOverride = require('method-override');
const client = require('prom-client');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config(); // Fallback nếu chạy trực tiếp trong thư mục app

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Nginx) để nhận biết đúng giao thức HTTPS và IP gốc
app.set('trust proxy', 1);

// ==============================================================================
// PROMETHEUS METRICS SETUP
// ==============================================================================
// Khởi tạo Registry để quản lý toàn bộ metrics
const register = new client.Registry();

// Bổ sung default metrics (CPU, Memory, Event Loop lag, v.v.)
client.collectDefaultMetrics({ register, prefix: 'nodejs_' });

// Custom metric: Bộ đếm tổng số HTTP requests
const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests received',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register]
});

// Custom metric: Thời gian phản hồi của HTTP requests (Histogram)
const httpRequestDurationSeconds = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [register]
});

// Cấu hình View Engine EJS
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Middlewares
// Middleware đo lường HTTP metrics (bỏ qua /metrics để tránh làm nhiễu số liệu)
app.use((req, res, next) => {
    if (req.path === '/metrics') {
        return next();
    }

    const start = process.hrtime();

    res.on('finish', () => {
        console.log(
            `[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode}`
        );
        const diff = process.hrtime(start);
        const durationInSeconds = diff[0] + diff[1] / 1e9;
        // Chuẩn hóa route pattern (ví dụ: /transactions/:id/edit thay vì ID thực tế)
        const routePath = req.route
            ? req.baseUrl + req.route.path
            : req.path.replace(/\/\d+(?=\/|$)/g, '/:id');
        const labels = {
            method: req.method,
            route: routePath || 'unknown',
            status_code: res.statusCode.toString()
        };

        httpRequestsTotal.inc(labels);
        httpRequestDurationSeconds.observe(labels, durationInSeconds);
    });

    next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// ==============================================================================
// SESSION & COOKIE CONFIGURATION (POSTGRESQL STORE)
// ==============================================================================
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && (!sessionSecret || Buffer.byteLength(sessionSecret, 'utf8') < 32)) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes in production.');
}
const effectiveSessionSecret = sessionSecret || 'dev_insecure_fallback_secret_must_change';

app.use(session({
    store: new pgSession({
        pool: db.pool,
        tableName: 'session',
        createTableIfMissing: false
    }),
    secret: effectiveSessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'expense_tracker_sid',
    cookie: {
        httpOnly: true,
        secure: isProduction ? 'auto' : false, // 'auto' tự động nhận diện HTTPS khi req.secure = true nhờ trust proxy
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 ngày
    }
}));

// ==============================================================================
// CSRF PROTECTION & VIEW LOCALS
// ==============================================================================
// Middleware tạo và kiểm tra CSRF token theo session
app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/metrics') {
        res.locals.csrfToken = '';
        res.locals.currentUser = null;
        return next();
    }

    if (req.session) {
        if (!req.session.csrfSecret) {
            req.session.csrfSecret = crypto.randomBytes(32).toString('hex');
        }
        res.locals.csrfToken = req.session.csrfSecret;
        res.locals.currentUser = req.session.user || null;
    } else {
        res.locals.csrfToken = '';
        res.locals.currentUser = null;
    }
    next();
});

// Middleware xác thực CSRF Token cho các HTTP verbs thay đổi trạng thái (POST, PUT, DELETE, PATCH)
function verifyCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }
    const tokenFromRequest = (req.body && req.body._csrf) ||
                            (req.headers && (req.headers['x-csrf-token'] || req.headers['csrf-token']));
    const expectedToken = req.session && req.session.csrfSecret;

    if (!expectedToken || !tokenFromRequest || tokenFromRequest !== expectedToken) {
        return res.status(403).render('login', {
            title: 'Lỗi bảo mật (CSRF)',
            errorMessage: 'Phiên làm việc hoặc mã bảo vệ form (CSRF) không hợp lệ. Vui lòng thử lại.',
            successMessage: null,
            email: ''
        });
    }
    next();
}

// Middleware xác thực quyền đăng nhập (bảo vệ các route cá nhân)
function ensureAuthenticated(req, res, next) {
    if (req.session && req.session.user && req.session.user.id) {
        return next();
    }
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ error: 'Yêu cầu đăng nhập để truy cập tài nguyên này.' });
    }
    res.redirect('/login');
}

// ==============================================================================
// RATE LIMITERS (CHỐNG BRUTE FORCE AUTH)
// ==============================================================================
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 phút
    max: 20, // tối đa 20 yêu cầu mỗi IP trong 15 phút
    // Chỉ tính các lần đăng nhập/đăng ký thất bại; thao tác thành công không
    // làm người dùng thật tự khóa mình khi sử dụng ứng dụng bình thường.
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Quá nhiều yêu cầu đăng nhập/đăng ký từ địa chỉ IP này. Vui lòng thử lại sau 15 phút.'
});

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
// 1. HEALTHCHECK & PROMETHEUS METRICS ENDPOINTS (CÔNG KHAI)
// ==============================================================================
app.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.status(200).json({ status: 'UP', database: 'connected', timestamp: new Date() });
    } catch (err) {
        console.error('Health check failed:', err.message);
        res.status(500).json({ status: 'DOWN', database: 'unavailable', timestamp: new Date() });
    }
});

// Endpoint xuất metrics chuẩn định dạng Prometheus
app.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    } catch (err) {
        console.error('Metrics collection failed:', err.message);
        res.status(500).end('Metrics unavailable.');
    }
});

// ==============================================================================
// 2. AUTHENTICATION ROUTES (REGISTER, LOGIN, LOGOUT)
// ==============================================================================

// Giao diện Đăng Ký
app.get('/register', (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect('/');
    }
    res.render('register', {
        title: 'Đăng Ký Tài Khoản',
        errorMessage: null,
        name: '',
        email: ''
    });
});

// Xử lý Đăng Ký Tài Khoản Mới
app.post('/register', authLimiter, verifyCsrf, async (req, res) => {
    try {
        const { name, email, password, confirmPassword } = req.body;
        const trimmedName = (name || '').trim();
        const trimmedEmail = (email || '').trim().toLowerCase();
        const rawPassword = password || '';

        // Validation cơ bản
        if (!trimmedName || !trimmedEmail || !rawPassword) {
            return res.status(400).render('register', {
                title: 'Đăng Ký Tài Khoản',
                errorMessage: 'Vui lòng điền đầy đủ tất cả các trường bắt buộc.',
                name: trimmedName,
                email: trimmedEmail
            });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmedEmail)) {
            return res.status(400).render('register', {
                title: 'Đăng Ký Tài Khoản',
                errorMessage: 'Địa chỉ email không hợp lệ.',
                name: trimmedName,
                email: trimmedEmail
            });
        }

        if (rawPassword.length < 6) {
            return res.status(400).render('register', {
                title: 'Đăng Ký Tài Khoản',
                errorMessage: 'Mật khẩu phải có độ dài tối thiểu 6 ký tự.',
                name: trimmedName,
                email: trimmedEmail
            });
        }

        if (rawPassword !== confirmPassword) {
            return res.status(400).render('register', {
                title: 'Đăng Ký Tài Khoản',
                errorMessage: 'Mật khẩu xác nhận không khớp.',
                name: trimmedName,
                email: trimmedEmail
            });
        }

        // Kiểm tra trùng email (chuẩn hóa chữ thường)
        const existing = await db.query(
            'SELECT id FROM users WHERE LOWER(TRIM(email)) = $1',
            [trimmedEmail]
        );
        if (existing.rows.length > 0) {
            return res.status(400).render('register', {
                title: 'Đăng Ký Tài Khoản',
                errorMessage: 'Email này đã được sử dụng. Vui lòng đăng nhập hoặc chọn email khác.',
                name: trimmedName,
                email: trimmedEmail
            });
        }

        // Băm mật khẩu bằng bcryptjs với salt rounds = 10
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(rawPassword, salt);

        // Lưu user vào PostgreSQL
        await db.query(
            'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)',
            [trimmedName, trimmedEmail, passwordHash]
        );

        res.render('login', {
            title: 'Đăng Nhập',
            errorMessage: null,
            successMessage: 'Đăng ký tài khoản thành công! Vui lòng đăng nhập để tiếp tục.',
            email: trimmedEmail
        });
    } catch (err) {
        console.error('Lỗi khi đăng ký tài khoản:', err.message);
        res.status(500).render('register', {
            title: 'Đăng Ký Tài Khoản',
            errorMessage: 'Đã xảy ra lỗi trong quá trình đăng ký. Vui lòng thử lại sau.',
            name: (req.body.name || '').trim(),
            email: (req.body.email || '').trim()
        });
    }
});

// Giao diện Đăng Nhập
app.get('/login', (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect('/');
    }
    res.render('login', {
        title: 'Đăng Nhập',
        errorMessage: null,
        successMessage: null,
        email: ''
    });
});

// Xử lý Đăng Nhập
app.post('/login', authLimiter, verifyCsrf, async (req, res) => {
    try {
        const { email, password } = req.body;
        const trimmedEmail = (email || '').trim().toLowerCase();
        const rawPassword = password || '';

        if (!trimmedEmail || !rawPassword) {
            return res.status(400).render('login', {
                title: 'Đăng Nhập',
                errorMessage: 'Vui lòng nhập đầy đủ email và mật khẩu.',
                successMessage: null,
                email: trimmedEmail
            });
        }

        // Tìm kiếm user theo email đã chuẩn hóa
        const userResult = await db.query(
            'SELECT id, name, email, password_hash FROM users WHERE LOWER(TRIM(email)) = $1',
            [trimmedEmail]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).render('login', {
                title: 'Đăng Nhập',
                errorMessage: 'Email hoặc mật khẩu không chính xác.',
                successMessage: null,
                email: trimmedEmail
            });
        }

        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(rawPassword, user.password_hash);

        if (!isMatch) {
            return res.status(401).render('login', {
                title: 'Đăng Nhập',
                errorMessage: 'Email hoặc mật khẩu không chính xác.',
                successMessage: null,
                email: trimmedEmail
            });
        }

        // Chống Session Fixation: Tái tạo session ID mới sau khi đăng nhập thành công
        const sessionUser = {
            id: user.id,
            name: user.name,
            email: user.email
        };

        req.session.regenerate((err) => {
            if (err) {
                console.error('Lỗi regenerate session:', err);
                return res.status(500).render('login', {
                    title: 'Đăng Nhập',
                    errorMessage: 'Lỗi thiết lập phiên làm việc an toàn.',
                    successMessage: null,
                    email: trimmedEmail
                });
            }

            req.session.user = sessionUser;
            req.session.csrfSecret = crypto.randomBytes(32).toString('hex');

            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('Lỗi lưu session:', saveErr);
                    return res.status(500).render('login', {
                        title: 'Đăng Nhập',
                        errorMessage: 'Không thể lưu phiên đăng nhập.',
                        successMessage: null,
                        email: trimmedEmail
                    });
                }
                res.redirect('/');
            });
        });
    } catch (err) {
        console.error('Lỗi xử lý đăng nhập:', err.message);
        res.status(500).render('login', {
            title: 'Đăng Nhập',
            errorMessage: 'Đã xảy ra lỗi máy chủ trong quá trình đăng nhập.',
            successMessage: null,
            email: (req.body.email || '').trim()
        });
    }
});

// Xử lý Đăng Xuất
app.post('/logout', verifyCsrf, (req, res) => {
    if (!req.session) {
        return res.redirect('/login');
    }

    req.session.destroy((err) => {
        if (err) {
            console.error('Lỗi khi hủy session logout:', err);
        }
        res.clearCookie('expense_tracker_sid');
        res.redirect('/login');
    });
});

// ==============================================================================
// 3. TRANG CHỦ / DASHBOARD (Tổng quan thu - chi - số dư THEO USER HIỆN TẠI)
// ==============================================================================
app.get('/', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;

        // 1. Tính tổng thu, tổng chi và số dư của riêng user đang đăng nhập
        const summaryResult = await db.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
            FROM transactions
            WHERE user_id = $1
        `, [userId]);
        const totalIncome = parseFloat(summaryResult.rows[0].total_income);
        const totalExpense = parseFloat(summaryResult.rows[0].total_expense);
        const netBalance = totalIncome - totalExpense;

        // 2. Lấy 6 giao dịch gần nhất của riêng user đang đăng nhập
        const recentResult = await db.query(`
            SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
            FROM transactions t
            LEFT JOIN categories c ON t.category_id = c.id
            WHERE t.user_id = $1
            ORDER BY t.transaction_date DESC, t.id DESC
            LIMIT 6
        `, [userId]);

        // 3. Lấy top 5 danh mục chi tiêu nhiều nhất của user
        const topExpensesResult = await db.query(`
            SELECT c.name, c.color, c.icon, SUM(t.amount) AS total_amount
            FROM transactions t
            JOIN categories c ON t.category_id = c.id
            WHERE t.type = 'expense' AND t.user_id = $1
            GROUP BY c.id, c.name, c.color, c.icon
            ORDER BY total_amount DESC
            LIMIT 5
        `, [userId]);

        // 4. Lấy danh sách danh mục dùng chung để phục vụ modal thêm nhanh
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
        res.status(500).send('Internal server error. Please try again later.');
    }
});

// ==============================================================================
// 4. QUẢN LÝ GIAO DỊCH (DANH SÁCH, LỌC, TÌM KIẾM THEO USER HIỆN TẠI)
// ==============================================================================
app.get('/transactions', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { type, category_id, start_date, end_date, search } = req.query;

        let queryText = `
            SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
            FROM transactions t
            LEFT JOIN categories c ON t.category_id = c.id
            WHERE t.user_id = $1
        `;
        const params = [userId];

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
        res.status(500).send('Internal server error. Please try again later.');
    }
});

// THÊM GIAO DỊCH MỚI (TỰ GÁN user_id TỪ SESSION)
app.post('/transactions', ensureAuthenticated, verifyCsrf, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { title, amount, type, category_id, transaction_date, notes } = req.body;
        
        if (!title || !amount || !type) {
            return res.status(400).send('Vui lòng điền đầy đủ tiêu đề, số tiền và loại giao dịch.');
        }

        await db.query(`
            INSERT INTO transactions (title, amount, type, category_id, transaction_date, notes, user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            title.trim(),
            parseFloat(amount),
            type,
            category_id ? parseInt(category_id) : null,
            transaction_date || new Date().toISOString().split('T')[0],
            notes ? notes.trim() : null,
            userId
        ]);

        res.redirect('/transactions');
    } catch (err) {
        console.error('Lỗi tạo giao dịch:', err);
        res.status(500).send('Internal server error. Please try again later.');
    }
});

// TRANG SỬA GIAO DỊCH (CHỈ CHO PHÉP XEM GIAO DỊCH CỦA CHÍNH MÌNH)
app.get('/transactions/:id/edit', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const id = parseInt(req.params.id);

        if (isNaN(id)) {
            return res.status(400).send('Mã giao dịch không hợp lệ.');
        }

        const transactionResult = await db.query(
            'SELECT * FROM transactions WHERE id = $1 AND user_id = $2',
            [id, userId]
        );
        
        if (transactionResult.rows.length === 0) {
            return res.status(404).send('Không tìm thấy giao dịch hoặc bạn không có quyền truy cập giao dịch này.');
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
        res.status(500).send('Internal server error. Please try again later.');
    }
});

// CẬP NHẬT GIAO DỊCH (GIỚI HẠN THEO CẢ ID VÀ user_id TỪ SESSION)
app.post('/transactions/:id/update', ensureAuthenticated, verifyCsrf, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const id = parseInt(req.params.id);

        if (isNaN(id)) {
            return res.status(400).send('Mã giao dịch không hợp lệ.');
        }

        const { title, amount, type, category_id, transaction_date, notes } = req.body;

        const updateResult = await db.query(`
            UPDATE transactions
            SET title = $1, amount = $2, type = $3, category_id = $4, transaction_date = $5, notes = $6, updated_at = CURRENT_TIMESTAMP
            WHERE id = $7 AND user_id = $8
        `, [
            title.trim(),
            parseFloat(amount),
            type,
            category_id ? parseInt(category_id) : null,
            transaction_date,
            notes ? notes.trim() : null,
            id,
            userId
        ]);

        if (updateResult.rowCount === 0) {
            return res.status(404).send('Không tìm thấy giao dịch hoặc bạn không có quyền cập nhật giao dịch này.');
        }

        res.redirect('/transactions');
    } catch (err) {
        console.error('Lỗi cập nhật giao dịch:', err);
        res.status(500).send('Internal server error. Please try again later.');
    }
});

// XÓA GIAO DỊCH (GIỚI HẠN THEO CẢ ID VÀ user_id TỪ SESSION)
app.post('/transactions/:id/delete', ensureAuthenticated, verifyCsrf, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const id = parseInt(req.params.id);

        if (isNaN(id)) {
            return res.status(400).send('Mã giao dịch không hợp lệ.');
        }

        const deleteResult = await db.query(
            'DELETE FROM transactions WHERE id = $1 AND user_id = $2',
            [id, userId]
        );

        if (deleteResult.rowCount === 0) {
            return res.status(404).send('Không tìm thấy giao dịch hoặc bạn không có quyền xóa giao dịch này.');
        }

        res.redirect('/transactions');
    } catch (err) {
        console.error('Lỗi xóa giao dịch:', err);
        res.status(500).send('Internal server error. Please try again later.');
    }
});

// ==============================================================================
// 5. QUẢN LÝ DANH MỤC THU / CHI (BẢO VỆ ĐĂNG NHẬP, DANH MỤC DÙNG CHUNG)
// ==============================================================================
app.get('/categories', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Đếm số giao dịch và tổng tiền của riêng user đối với từng danh mục
        const categoriesResult = await db.query(`
            SELECT c.*,
                   COUNT(t.id) FILTER (WHERE t.user_id = $1) AS transaction_count,
                   COALESCE(SUM(t.amount) FILTER (WHERE t.user_id = $1), 0) AS total_amount
            FROM categories c
            LEFT JOIN transactions t ON c.id = t.category_id AND t.user_id = $1
            GROUP BY c.id
            ORDER BY c.type DESC, c.name ASC
        `, [userId]);

        res.render('categories', {
            title: 'Quản lý danh mục',
            categories: categoriesResult.rows,
            activePage: 'categories'
        });
    } catch (err) {
        console.error('Lỗi tải danh mục:', err);
        res.status(500).send('Internal server error. Please try again later.');
    }
});

// THÊM DANH MỤC MỚI (BẢO VỆ CSRF)
app.post('/categories', ensureAuthenticated, verifyCsrf, async (req, res) => {
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
        res.status(500).send('Internal server error. Please try again later.');
    }
});

// XÓA DANH MỤC
app.post('/categories/:id/delete', ensureAuthenticated, verifyCsrf, async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).send('Mã danh mục không hợp lệ.');
        }

        // Khóa danh mục trong transaction để không làm FK ON DELETE SET NULL
        // âm thầm thay đổi giao dịch đang sử dụng danh mục này.
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const categoryResult = await client.query(
                'SELECT id FROM categories WHERE id = $1 FOR UPDATE',
                [id]
            );
            if (categoryResult.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).send('Không tìm thấy danh mục.');
            }

            const usageResult = await client.query(
                'SELECT 1 FROM transactions WHERE category_id = $1 LIMIT 1',
                [id]
            );
            if (usageResult.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).send('Không thể xóa danh mục đang được giao dịch sử dụng.');
            }

            await client.query('DELETE FROM categories WHERE id = $1', [id]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        res.redirect('/categories');
    } catch (err) {
        console.error('Lỗi xóa danh mục:', err);
        res.status(500).send('Internal server error. Please try again later.');
    }
});

// ==============================================================================
// 6. TRANG BÁO CÁO & THỐNG KÊ CHI TIẾT (THEO USER HIỆN TẠI)
// ==============================================================================
app.get('/reports', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;

        // 1. Tổng quát
        const summary = await db.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense,
                COUNT(*) AS total_transactions
            FROM transactions
            WHERE user_id = $1
        `, [userId]);
        const totalIncome = parseFloat(summary.rows[0].total_income);
        const totalExpense = parseFloat(summary.rows[0].total_expense);
        const netBalance = totalIncome - totalExpense;
        const totalTransactions = parseInt(summary.rows[0].total_transactions);

        // 2. Thống kê theo Danh mục chi tiêu của user
        const expenseByCategory = await db.query(`
            SELECT 
                c.name, c.color, c.icon,
                SUM(t.amount) AS total_amount,
                COUNT(t.id) AS count
            FROM transactions t
            JOIN categories c ON t.category_id = c.id
            WHERE t.type = 'expense' AND t.user_id = $1
            GROUP BY c.id, c.name, c.color, c.icon
            ORDER BY total_amount DESC
        `, [userId]);

        // 3. Thống kê theo Danh mục thu nhập của user
        const incomeByCategory = await db.query(`
            SELECT 
                c.name, c.color, c.icon,
                SUM(t.amount) AS total_amount,
                COUNT(t.id) AS count
            FROM transactions t
            JOIN categories c ON t.category_id = c.id
            WHERE t.type = 'income' AND t.user_id = $1
            GROUP BY c.id, c.name, c.color, c.icon
            ORDER BY total_amount DESC
        `, [userId]);

        // 4. Thống kê theo tháng gần đây của user
        const monthlyStats = await db.query(`
            SELECT 
                TO_CHAR(transaction_date, 'YYYY-MM') AS month_year,
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS month_income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS month_expense
            FROM transactions
            WHERE user_id = $1
            GROUP BY month_year
            ORDER BY month_year DESC
            LIMIT 12
        `, [userId]);

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
        res.status(500).send('Internal server error. Please try again later.');
    }
});

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`====================================================`);
        console.log(`🚀 EXPENSE TRACKER WEB APP ĐANG CHẠY!`);
        console.log(`📍 Địa chỉ: http://localhost:${PORT}`);
        console.log(`====================================================`);
    });
}

module.exports = app;
