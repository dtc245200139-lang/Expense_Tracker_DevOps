-- ==============================================================================
-- DATABASE INITIALIZATION SCRIPT CHO HỆ THỐNG QUẢN LÝ CHI TIÊU (EXPENSE TRACKER)
-- ==============================================================================

-- 1. Bảng Danh mục (Categories)
CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(10) NOT NULL CHECK (type IN ('income', 'expense')),
    icon VARCHAR(50) DEFAULT 'bi-tag',
    color VARCHAR(20) DEFAULT '#0d6efd',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Bảng Giao dịch thu chi (Transactions)
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    amount NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
    type VARCHAR(10) NOT NULL CHECK (type IN ('income', 'expense')),
    category_id INT REFERENCES categories(id) ON DELETE SET NULL,
    transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tạo chỉ mục (Index) để tối ưu truy vấn tìm kiếm và lọc theo ngày/loại
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);

-- 3. Chèn dữ liệu mẫu cho Danh mục nếu chưa có
INSERT INTO categories (name, type, icon, color) VALUES
    ('Tiền lương', 'income', 'bi-cash-coin', '#198754'),
    ('Tiền thưởng', 'income', 'bi-award', '#20c997'),
    ('Đầu tư / Lãi tiết kiệm', 'income', 'bi-graph-up-arrow', '#0dcaf0'),
    ('Thu nhập khác', 'income', 'bi-wallet2', '#6f42c1'),
    ('Ăn uống & Tiệc tùng', 'expense', 'bi-cup-hot', '#fd7e14'),
    ('Nhà ở & Tiền điện nước', 'expense', 'bi-house-door', '#dc3545'),
    ('Đi lại & Xăng xe', 'expense', 'bi-fuel-pump', '#ffc107'),
    ('Mua sắm cá nhân', 'expense', 'bi-bag-heart', '#d63384'),
    ('Y tế & Sức khỏe', 'expense', 'bi-heart-pulse', '#e83e8c'),
    ('Giáo dục & Sách vở', 'expense', 'bi-book', '#0d6efd'),
    ('Giải trí & Thể thao', 'expense', 'bi-controller', '#6610f2')
ON CONFLICT DO NOTHING;

-- 4. Chèn giao dịch mẫu
INSERT INTO transactions (title, amount, type, category_id, transaction_date, notes) VALUES
    ('Nhận lương tháng này', 25000000, 'income', 1, CURRENT_DATE - INTERVAL '10 day', 'Lương công ty chuyển khoản'),
    ('Thưởng hoàn thành dự án', 5000000, 'income', 2, CURRENT_DATE - INTERVAL '5 day', 'Thưởng nóng từ quản lý'),
    ('Lãi tiết kiệm ngân hàng', 650000, 'income', 3, CURRENT_DATE - INTERVAL '2 day', 'Tiết kiệm kỳ hạn 6 tháng'),
    ('Đi siêu thị mua thực phẩm tuần', 1450000, 'expense', 5, CURRENT_DATE - INTERVAL '8 day', 'Thực phẩm, rau củ quả, sữa'),
    ('Thanh toán tiền điện và Internet', 1200000, 'expense', 6, CURRENT_DATE - INTERVAL '6 day', 'Hóa đơn tháng qua app ngân hàng'),
    ('Đổ xăng ô tô/xe máy', 350000, 'expense', 7, CURRENT_DATE - INTERVAL '4 day', 'Đầy bình xăng'),
    ('Mua sách chuyên ngành DevOps', 480000, 'expense', 10, CURRENT_DATE - INTERVAL '3 day', 'Sách Docker & Prometheus thực chiến'),
    ('Xem phim & Cà phê cuối tuần', 320000, 'expense', 11, CURRENT_DATE - INTERVAL '1 day', 'Gặp gỡ bạn bè'),
    ('Mua sắm đồ dùng gia đình', 890000, 'expense', 8, CURRENT_DATE, 'Đồ gia dụng tiện ích')
ON CONFLICT DO NOTHING;
