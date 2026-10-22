-- ==============================================================================
-- MIGRATION SCRIPT 001: BỔ SUNG XÁC THỰC NGƯỜI DÙNG & SESSION STORE CHO EXPENSE TRACKER
-- (REVISION 9: HOÀN THIỆN ĐỌC INDKEY THEO CHUẨN INT2VECTOR & SO SÁNH CHÍNH XÁC USER_ID BASELINE)
-- ==============================================================================
-- Nguyên tắc an toàn:
-- 1. Toàn bộ migration chạy trong một transaction duy nhất (BEGIN/COMMIT).
--    Nếu bất kỳ bước kiểm tra hoặc DDL nào thất bại, toàn bộ sẽ tự động ROLLBACK.
-- 2. Kiểm tra xung đột schema sâu thông qua pg_catalog (pg_constraint, pg_index, pg_class):
--    Nếu đối tượng đã tồn tại nhưng sai cấu trúc, RAISE EXCEPTION và dừng ngay.
--    Tuyệt đối không tự sửa hoặc xóa cấu trúc đang tồn tại.
-- 3. Giữ nguyên 100% dữ liệu: không có UPDATE, DELETE, TRUNCATE hay DROP.
-- 4. Cột `user_id` trong `transactions` là INT NULL:
--    14 giao dịch cũ giữ nguyên user_id = NULL, tuyệt đối không tự động gán.
-- 5. Bảng `categories` không bị tác động bởi bất kỳ dòng nào trong script này.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- PHẦN 0A: GHI NHẬN BASELINE SỐ LƯỢNG TRƯỚC DDL (Bảng tạm tự xóa khi kết thúc Transaction)
-- Lưu ý an toàn: Sử dụng khối PL/pgSQL với SQL động (EXECUTE) để đếm `user_id IS NOT NULL`
-- chỉ khi cột `user_id` đã tồn tại trong schema. Nếu cột chưa có (trạng thái ban đầu),
-- ghi nhận baseline an toàn bằng 0, tránh hoàn toàn lỗi biên dịch SQL tĩnh khi phân tích cú pháp.
-- Migration này yêu cầu chạy ở trạng thái bảo trì/không có thao tác ghi-xóa đồng thời từ bên ngoài.
-- ==============================================================================
CREATE TEMP TABLE _migration_baseline (
    pre_transaction_count       BIGINT,
    pre_category_count          BIGINT,
    pre_user_id_assigned_count  BIGINT
) ON COMMIT DROP;

DO $$
DECLARE
    v_pre_tx      BIGINT;
    v_pre_cat     BIGINT;
    v_pre_uid_cnt BIGINT := 0;
BEGIN
    SELECT COUNT(*) INTO v_pre_tx FROM public.transactions;
    SELECT COUNT(*) INTO v_pre_cat FROM public.categories;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'transactions'
          AND column_name = 'user_id'
    ) THEN
        EXECUTE 'SELECT COUNT(*) FROM public.transactions WHERE user_id IS NOT NULL' INTO v_pre_uid_cnt;
    ELSE
        v_pre_uid_cnt := 0;
    END IF;

    INSERT INTO _migration_baseline (pre_transaction_count, pre_category_count, pre_user_id_assigned_count)
    VALUES (v_pre_tx, v_pre_cat, v_pre_uid_cnt);
END $$;


-- ==============================================================================
-- PHẦN 0B: KIỂM TRA XUNG ĐỘT SCHEMA NGUYÊN TỬ QUA PG_CATALOG
-- Nếu phát hiện bảng/cột/chỉ mục/khóa ngoại đã tồn tại nhưng sai cấu trúc,
-- script sẽ RAISE EXCEPTION lập tức hủy bỏ transaction.
-- ==============================================================================
DO $$
DECLARE
    v_col_type          TEXT;
    v_col_nullable      TEXT;
    v_pk_constraint_cnt INT;
    v_pk_col_count      INT;
    v_pk_attname        TEXT;
    v_idx_total_count   INT;
    v_idx_target_count  INT;
    v_idx_indnatts      INT;
    v_idx_indnkeyatts   INT;
    v_idx_first_col     TEXT;
    v_idx_is_valid      BOOLEAN;
    v_idx_is_ready      BOOLEAN;
    v_idx_is_unique     BOOLEAN;
    v_idx_has_pred      BOOLEAN;
    v_idx_norm_expr     TEXT;
    v_fk_count          INT;
    v_fk_invalid_count  INT;
BEGIN

    -- =========================================================================
    -- KIỂM TRA 1: Bảng `public.users` (Nếu đã tồn tại)
    -- =========================================================================
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
    ) THEN

        -- 1a. Kiểm tra cột `id`: kiểu integer/int4, tương thích với transactions.user_id (INT)
        SELECT data_type INTO v_col_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id';

        IF v_col_type IS NULL THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.id]: Bảng users đã tồn tại nhưng thiếu cột id. Dừng migration.';
        END IF;
        IF v_col_type NOT IN ('integer', 'bigint') THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.id]: Kiểu dữ liệu không tương thích (tìm thấy: %, yêu cầu: integer). Dừng migration.', v_col_type;
        END IF;

        -- 1b. Kiểm tra khóa chính: bảng users BẮT BUỘC có DUY NHẤT 1 ràng buộc PRIMARY KEY,
        --     và khóa chính đó gồm ĐÚNG 1 CỘT `id` của bảng public.users
        SELECT COUNT(*) INTO v_pk_constraint_cnt
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'public'
          AND t.relname = 'users'
          AND c.contype = 'p';

        IF v_pk_constraint_cnt = 0 THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users PRIMARY KEY]: Bảng users đã tồn tại nhưng thiếu ràng buộc khóa chính (PRIMARY KEY). Dừng migration.';
        END IF;
        IF v_pk_constraint_cnt > 1 THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users PRIMARY KEY]: Phát hiện nhiều ràng buộc khóa chính bất thường trên bảng users. Dừng migration.';
        END IF;

        SELECT
            cardinality(c.conkey),
            a.attname
        INTO v_pk_col_count, v_pk_attname
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
        WHERE n.nspname = 'public'
          AND t.relname = 'users'
          AND c.contype = 'p';

        IF v_pk_col_count <> 1 OR v_pk_attname IS DISTINCT FROM 'id' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users PRIMARY KEY]: Khóa chính của bảng users phải gồm đúng duy nhất một cột id (tìm thấy: % cột, cột đầu tiên: %). Dừng migration.', v_pk_col_count, COALESCE(v_pk_attname, 'NULL');
        END IF;

        -- 1c. Kiểm tra cột `name`: varchar/text, NOT NULL
        SELECT data_type, is_nullable INTO v_col_type, v_col_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'name';

        IF v_col_type IS NULL THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.name]: Bảng users đã tồn tại nhưng thiếu cột name. Dừng migration.';
        END IF;
        IF v_col_type NOT IN ('character varying', 'text') THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.name]: Kiểu dữ liệu không hợp lệ (tìm thấy: %). Dừng migration.', v_col_type;
        END IF;
        IF v_col_nullable = 'YES' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.name]: Cột name cho phép NULL nhưng yêu cầu NOT NULL. Dừng migration.';
        END IF;

        -- 1d. Kiểm tra cột `email`: varchar/text, NOT NULL
        SELECT data_type, is_nullable INTO v_col_type, v_col_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email';

        IF v_col_type IS NULL THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.email]: Bảng users đã tồn tại nhưng thiếu cột email. Dừng migration.';
        END IF;
        IF v_col_type NOT IN ('character varying', 'text') THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.email]: Kiểu dữ liệu không hợp lệ (tìm thấy: %). Dừng migration.', v_col_type;
        END IF;
        IF v_col_nullable = 'YES' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.email]: Cột email cho phép NULL nhưng yêu cầu NOT NULL. Dừng migration.';
        END IF;

        -- 1e. Kiểm tra cột `password_hash`: varchar/text, NOT NULL
        SELECT data_type, is_nullable INTO v_col_type, v_col_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_hash';

        IF v_col_type IS NULL THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.password_hash]: Bảng users đã tồn tại nhưng thiếu cột password_hash. Dừng migration.';
        END IF;
        IF v_col_type NOT IN ('character varying', 'text') THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.password_hash]: Kiểu dữ liệu không hợp lệ (tìm thấy: %). Dừng migration.', v_col_type;
        END IF;
        IF v_col_nullable = 'YES' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.password_hash]: Cột password_hash cho phép NULL nhưng yêu cầu NOT NULL. Dừng migration.';
        END IF;

        -- 1f. Kiểm tra cột `created_at`: phải tồn tại và có kiểu timestamp
        SELECT data_type INTO v_col_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'created_at';

        IF v_col_type IS NULL THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.created_at]: Bảng users đã tồn tại nhưng thiếu cột created_at. Dừng migration.';
        END IF;
        IF v_col_type NOT IN ('timestamp with time zone', 'timestamp without time zone') THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [users.created_at]: Cột created_at phải có kiểu timestamp (tìm thấy: %). Dừng migration.', v_col_type;
        END IF;

        RAISE NOTICE 'PASS [users]: Bảng users đã tồn tại với cấu trúc hợp lệ.';
    END IF;

    -- =========================================================================
    -- KIỂM TRA 2: Unique Index `idx_users_unique_lower_email` (Nếu đã tồn tại ở bất kỳ đâu)
    -- =========================================================================
    -- 2a. Đếm số lượng index mang tên này trên TOÀN BỘ database ở mọi schema
    SELECT COUNT(*) INTO v_idx_total_count
    FROM pg_class i
    JOIN pg_namespace n ON i.relnamespace = n.oid
    WHERE i.relname = 'idx_users_unique_lower_email'
      AND i.relkind = 'i';

    -- 2b. Đếm số lượng index mang tên này trên đúng bảng đích `public.users`
    SELECT COUNT(*) INTO v_idx_target_count
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE i.relname = 'idx_users_unique_lower_email'
      AND n.nspname = 'public'
      AND t.relname = 'users';

    -- Phát hiện xung đột tên index nếu tồn tại ở bảng/schema khác
    IF v_idx_total_count > 0 AND v_idx_target_count = 0 THEN
        RAISE EXCEPTION 'SCHEMA CONFLICT [idx_users_unique_lower_email]: Index mang tên này tồn tại trong cơ sở dữ liệu nhưng KHÔNG thuộc bảng public.users. Dừng migration.';
    END IF;

    IF v_idx_total_count > 1 THEN
        RAISE EXCEPTION 'SCHEMA CONFLICT [idx_users_unique_lower_email]: Phát hiện % index trùng tên trên nhiều bảng/schema. Dừng migration.', v_idx_total_count;
    END IF;

    IF v_idx_target_count = 1 THEN
        -- Truy vấn metadata chi tiết từ pg_index:
        -- indnatts: tổng số cột/khóa (bao gồm cả INCLUDE column nếu có)
        -- indnkeyatts: số lượng key attributes thực tế dùng cho indexing
        -- Chuyển int2vector sang mảng mảng text hoặc split_part để truy xuất an toàn index key đầu tiên
        SELECT
            x.indisunique,
            x.indisvalid,
            x.indisready,
            x.indnatts,
            x.indnkeyatts,
            split_part(x.indkey::text, ' ', 1),
            (x.indpred IS NOT NULL),
            regexp_replace(lower(pg_get_expr(x.indexprs, x.indrelid)), '\s+', '', 'g')
        INTO
            v_idx_is_unique,
            v_idx_is_valid,
            v_idx_is_ready,
            v_idx_indnatts,
            v_idx_indnkeyatts,
            v_idx_first_col,
            v_idx_has_pred,
            v_idx_norm_expr
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE i.relname = 'idx_users_unique_lower_email'
          AND n.nspname = 'public'
          AND t.relname = 'users';

        IF NOT v_idx_is_unique THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [idx_users_unique_lower_email]: Index tồn tại nhưng KHÔNG PHẢI là UNIQUE index. Dừng migration.';
        END IF;

        IF NOT v_idx_is_valid OR NOT v_idx_is_ready THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [idx_users_unique_lower_email]: Index tồn tại nhưng ở trạng thái không hợp lệ (indisvalid=%, indisready=%). Cần REINDEX hoặc kiểm tra thủ công. Dừng migration.', v_idx_is_valid, v_idx_is_ready;
        END IF;

        IF v_idx_has_pred THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [idx_users_unique_lower_email]: Index tồn tại nhưng có vị từ điều kiện (partial index predicate) ngoài dự kiến. Dừng migration.';
        END IF;

        -- Xác minh CHÍNH XÁC cấu trúc khóa index:
        -- Bắt buộc có ĐÚNG 1 khóa index (indnatts = 1 và indnkeyatts = 1), không chứa thêm bất kỳ cột khóa hoặc include column nào khác
        IF v_idx_indnatts <> 1 OR v_idx_indnkeyatts <> 1 THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [idx_users_unique_lower_email]: Index phải có đúng duy nhất 1 khóa index (tìm thấy: indnatts=%, indnkeyatts=%). Dừng migration.', v_idx_indnatts, v_idx_indnkeyatts;
        END IF;

        -- Khóa duy nhất đó BẮT BUỘC phải là khóa biểu thức (expression key), tức cột đầu tiên trong indkey biểu diễn dạng chuỗi là '0'
        IF v_idx_first_col IS DISTINCT FROM '0' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [idx_users_unique_lower_email]: Khóa index không phải là biểu thức hàm (indkey đầu tiên: %, yêu cầu 0 cho expression). Dừng migration.', v_idx_first_col;
        END IF;

        -- Xác minh CHẶT CHẼ biểu thức indexprs:
        -- PostgreSQL canonicalize biểu thức LOWER(TRIM(email)) thành lower(btrim((email)::text))
        -- Sau khi xóa toàn bộ khoảng trắng bằng regexp_replace, biểu thức BẮT BUỘC phải khớp:
        -- 'lower(btrim((email)::text))' hoặc 'lower(btrim(email))' hoặc 'lower(trim((email)::text))' hoặc 'lower(trim(email))'
        IF v_idx_norm_expr IS NULL OR v_idx_norm_expr NOT IN (
            'lower(btrim((email)::text))',
            'lower(btrim(email))',
            'lower(trim((email)::text))',
            'lower(trim(email))'
        ) THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [idx_users_unique_lower_email]: Biểu thức cột index không xác minh được tính tương đương tuyệt đối với LOWER(TRIM(email)) (chuẩn hóa tìm thấy: %). Dừng migration.', COALESCE(v_idx_norm_expr, 'NULL');
        END IF;

        RAISE NOTICE 'PASS [idx_users_unique_lower_email]: Index đã tồn tại và hợp lệ 100%% với duy nhất 1 khóa biểu thức LOWER(TRIM(email)).';
    END IF;

    -- =========================================================================
    -- KIỂM TRA 3: Bảng `public.session` (Nếu đã tồn tại)
    -- =========================================================================
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'session'
    ) THEN

        -- 3a. Cột `sid`: varchar/text, NOT NULL
        SELECT data_type, is_nullable INTO v_col_type, v_col_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'sid';

        IF v_col_type IS NULL THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session.sid]: Bảng session đã tồn tại nhưng thiếu cột sid. Dừng migration.';
        END IF;
        IF v_col_type NOT IN ('character varying', 'text') THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session.sid]: Kiểu dữ liệu không hợp lệ (tìm thấy: %). Dừng migration.', v_col_type;
        END IF;
        IF v_col_nullable = 'YES' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session.sid]: Cột sid cho phép NULL nhưng yêu cầu NOT NULL. Dừng migration.';
        END IF;

        -- 3b. Cột `sess`: json/jsonb, NOT NULL
        SELECT data_type, is_nullable INTO v_col_type, v_col_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'sess';

        IF v_col_type IS NULL THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session.sess]: Bảng session đã tồn tại nhưng thiếu cột sess. Dừng migration.';
        END IF;
        IF v_col_type NOT IN ('json', 'jsonb') THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session.sess]: Kiểu dữ liệu không hợp lệ (tìm thấy: %, yêu cầu: json). Dừng migration.', v_col_type;
        END IF;
        IF v_col_nullable = 'YES' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session.sess]: Cột sess cho phép NULL nhưng yêu cầu NOT NULL. Dừng migration.';
        END IF;

        -- 3c. Cột `expire`: timestamp, NOT NULL
        SELECT data_type, is_nullable INTO v_col_type, v_col_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'expire';

        IF v_col_type IS NULL THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session.expire]: Bảng session đã tồn tại nhưng thiếu cột expire. Dừng migration.';
        END IF;
        IF v_col_type NOT IN ('timestamp without time zone', 'timestamp with time zone') THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session.expire]: Kiểu dữ liệu không hợp lệ (tìm thấy: %). Dừng migration.', v_col_type;
        END IF;
        IF v_col_nullable = 'YES' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session.expire]: Cột expire cho phép NULL nhưng yêu cầu NOT NULL. Dừng migration.';
        END IF;

        -- 3d. Khóa chính: Bảng session BẮT BUỘC có DUY NHẤT 1 ràng buộc PRIMARY KEY,
        --     và khóa chính đó gồm ĐÚNG 1 CỘT `sid` của bảng public.session
        SELECT COUNT(*) INTO v_pk_constraint_cnt
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'public'
          AND t.relname = 'session'
          AND c.contype = 'p';

        IF v_pk_constraint_cnt = 0 THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session PRIMARY KEY]: Bảng session tồn tại nhưng thiếu ràng buộc khóa chính (PRIMARY KEY). Dừng migration.';
        END IF;
        IF v_pk_constraint_cnt > 1 THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session PRIMARY KEY]: Phát hiện nhiều ràng buộc khóa chính bất thường trên bảng session. Dừng migration.';
        END IF;

        SELECT
            cardinality(c.conkey),
            a.attname
        INTO v_pk_col_count, v_pk_attname
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
        WHERE n.nspname = 'public'
          AND t.relname = 'session'
          AND c.contype = 'p';

        IF v_pk_col_count <> 1 OR v_pk_attname IS DISTINCT FROM 'sid' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [session PRIMARY KEY]: Khóa chính của bảng session phải gồm đúng duy nhất một cột sid (tìm thấy: % cột, cột đầu: %). Dừng migration.', v_pk_col_count, COALESCE(v_pk_attname, 'NULL');
        END IF;

        RAISE NOTICE 'PASS [session]: Bảng session đã tồn tại với cấu trúc hợp lệ.';
    END IF;

    -- =========================================================================
    -- KIỂM TRA 4: Cột `transactions.user_id` & Khóa ngoại (Nếu đã tồn tại)
    -- =========================================================================
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'transactions'
          AND column_name  = 'user_id'
    ) THEN

        -- 4a. Cột user_id phải là integer/bigint và BẮT BUỘC là NULL (is_nullable = YES)
        SELECT data_type, is_nullable INTO v_col_type, v_col_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'transactions'
          AND column_name  = 'user_id';

        IF v_col_type NOT IN ('integer', 'bigint') THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [transactions.user_id]: Kiểu dữ liệu không tương thích (tìm thấy: %, yêu cầu: integer). Dừng migration.', v_col_type;
        END IF;

        IF v_col_nullable = 'NO' THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [transactions.user_id]: Cột user_id hiện là NOT NULL (yêu cầu bắt buộc là NULL để bảo toàn 14 giao dịch cũ). Dừng migration.';
        END IF;

        -- 4b. Kiểm tra khóa ngoại chính xác: public.transactions.user_id -> public.users.id
        -- Yêu cầu: đúng 1 FK đơn cột, confdeltype = 'r' (RESTRICT), convalidated = true
        SELECT
            COUNT(*),
            COUNT(*) FILTER (WHERE c.confdeltype <> 'r' OR NOT c.convalidated)
        INTO v_fk_count, v_fk_invalid_count
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace tn ON t.relnamespace = tn.oid
        JOIN pg_class ft ON c.confrelid = ft.oid
        JOIN pg_namespace ftn ON ft.relnamespace = ftn.oid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
        JOIN pg_attribute fa ON fa.attrelid = ft.oid AND fa.attnum = c.confkey[1]
        WHERE c.contype = 'f'
          AND tn.nspname = 'public'
          AND t.relname = 'transactions'
          AND a.attname = 'user_id'
          AND ftn.nspname = 'public'
          AND ft.relname = 'users'
          AND fa.attname = 'id'
          AND cardinality(c.conkey) = 1
          AND cardinality(c.confkey) = 1;

        IF v_fk_count = 0 THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [transactions.user_id FK]: Cột user_id đã tồn tại nhưng THIẾU khóa ngoại đơn tham chiếu chính xác sang public.users(id). Dừng migration, không tự sửa.';
        END IF;

        IF v_fk_count > 1 THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [transactions.user_id FK]: Phát hiện % khóa ngoại trùng lặp từ transactions.user_id sang users.id. Dừng migration.', v_fk_count;
        END IF;

        IF v_fk_invalid_count > 0 THEN
            RAISE EXCEPTION 'SCHEMA CONFLICT [transactions.user_id FK]: Khóa ngoại tồn tại nhưng không thỏa mãn đồng thời ON DELETE RESTRICT (confdeltype=r) và convalidated=true. Dừng migration.';
        END IF;

        RAISE NOTICE 'PASS [transactions.user_id]: Cột user_id và khóa ngoại ON DELETE RESTRICT đã tồn tại và hợp lệ 100%%.';
    END IF;

    RAISE NOTICE 'PASS [Phần 0B hoàn tất]: Kiểm tra xung đột schema an toàn qua pg_catalog thành công. Tiến hành DDL.';
END $$;


-- ==============================================================================
-- PHẦN 1: TẠO BẢNG USERS VÀ FUNCTIONAL UNIQUE INDEX
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.users (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(100) NOT NULL,
    email         VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Functional Unique Index không phân biệt hoa/thường, đồng bộ logic backend: email.trim().toLowerCase()
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_lower_email ON public.users (LOWER(TRIM(email)));


-- ==============================================================================
-- PHẦN 2: TẠO BẢNG SESSION (Tương thích chuẩn connect-pg-simple v10.0.0)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public."session" (
    "sid"    varchar      NOT NULL COLLATE "default",
    "sess"   json         NOT NULL,
    "expire" timestamp(6) NOT NULL,
    CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON public."session" ("expire");


-- ==============================================================================
-- PHẦN 3: BỔ SUNG CỘT user_id VÀO BẢNG TRANSACTIONS (IDEMPOTENT)
-- 14 giao dịch cũ sẽ tự động mang giá trị user_id = NULL. Tuyệt đối không gán cho bất kỳ ai.
-- ==============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'transactions'
          AND column_name  = 'user_id'
    ) THEN
        ALTER TABLE public.transactions
            ADD COLUMN user_id INT NULL
            REFERENCES public.users(id) ON DELETE RESTRICT;
        RAISE NOTICE 'OK [Phần 3]: Đã thêm cột user_id (INT NULL, FK -> users.id ON DELETE RESTRICT).';
    ELSE
        RAISE NOTICE 'SKIP [Phần 3]: Cột user_id và khóa ngoại đã tồn tại hợp lệ. Bỏ qua ADD COLUMN.';
    END IF;
END $$;

-- Tạo index cho user_id phục vụ truy vấn phân tách dữ liệu giao dịch theo người dùng
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions (user_id);


-- ==============================================================================
-- PHẦN 4: KIỂM TRA ĐỐI CHIẾU SỐ LƯỢNG SAU DDL VÀ GHI RÕ GIỚI HẠN KỸ THUẬT
-- ==============================================================================
DO $$
DECLARE
    v_pre_transactions    BIGINT;
    v_pre_categories      BIGINT;
    v_pre_user_id_count   BIGINT;
    v_post_transactions   BIGINT;
    v_post_categories     BIGINT;
    v_post_user_id_count  BIGINT;
BEGIN
    -- Lấy baseline ghi nhận trước khi chạy DDL
    SELECT pre_transaction_count, pre_category_count, pre_user_id_assigned_count
    INTO   v_pre_transactions, v_pre_categories, v_pre_user_id_count
    FROM   _migration_baseline;

    -- Đếm số lượng thực tế hiện tại
    SELECT COUNT(*) INTO v_post_transactions FROM public.transactions;
    SELECT COUNT(*) INTO v_post_categories   FROM public.categories;
    SELECT COUNT(*) INTO v_post_user_id_count FROM public.transactions WHERE user_id IS NOT NULL;

    -- 4a. Kiểm tra số lượng giao dịch: post_count không được nhỏ hơn pre_count
    IF v_post_transactions < v_pre_transactions THEN
        RAISE EXCEPTION 'KIỂM TRA THẤT BẠI [transactions]: Số lượng giao dịch bị giảm từ % xuống %! ROLLBACK toàn bộ.', v_pre_transactions, v_post_transactions;
    END IF;

    -- 4b. Kiểm tra số lượng danh mục phải bằng nhau
    IF v_post_categories <> v_pre_categories THEN
        RAISE EXCEPTION 'KIỂM TRA THẤT BẠI [categories]: Số lượng danh mục thay đổi từ % thành %! ROLLBACK toàn bộ.', v_pre_categories, v_post_categories;
    END IF;

    -- 4c. Kiểm tra số lượng giao dịch có user_id IS NOT NULL trước và sau migration BẮT BUỘC PHẢI BẰNG NHAU
    -- Script migration tuyệt đối không được phép cập nhật hay tự ý gán user_id cho bất kỳ giao dịch nào.
    IF v_post_user_id_count <> v_pre_user_id_count THEN
        RAISE EXCEPTION 'KIỂM TRA THẤT BẠI [user_id]: Số lượng giao dịch có user_id bị thay đổi (Trước = %, Sau = %)! Script không cho phép gán hoặc sửa đổi user_id. ROLLBACK toàn bộ.', v_pre_user_id_count, v_post_user_id_count;
    END IF;

    -- Báo cáo kết quả và nêu rõ chính xác các điều kiện được kiểm tra cùng giới hạn kỹ thuật:
    RAISE NOTICE '====================================================================';
    RAISE NOTICE 'BÁO CÁO ĐỐI CHIẾU SỐ LƯỢNG SAU MIGRATION:';
    RAISE NOTICE '1. Giao dịch (transactions) : Trước = %, Sau = % (Điều kiện kiểm tra: Sau >= Trước; KHÔNG chứng minh không bị mất bản ghi cũ nếu có thao tác ghi chèn đồng thời).', v_pre_transactions, v_post_transactions;
    RAISE NOTICE '2. Danh mục (categories)    : Trước = %, Sau = % (Điều kiện kiểm tra: Sau = Trước; KHÔNG chứng minh nội dung danh mục không đổi nếu có sửa đồng thời).', v_pre_categories, v_post_categories;
    RAISE NOTICE '3. Giao dịch có user_id     : Trước = %, Sau = % (Điều kiện kiểm tra: Sau = Trước; bảo đảm số lượng giao dịch có user_id không bị thay đổi trong quá trình migration).', v_pre_user_id_count, v_post_user_id_count;
    RAISE NOTICE '--------------------------------------------------------------------';
    RAISE NOTICE 'YÊU CẦU BẢO TRÌ & GIỚI HẠN KỸ THUẬT:';
    RAISE NOTICE '- Migration BẮT BUỘC phải chạy trong cửa sổ bảo trì, không có tiến trình ghi/sửa/xóa đồng thời từ ứng dụng hoặc người dùng.';
    RAISE NOTICE '- Việc đối chiếu COUNT(*) chỉ là điều kiện cần về số lượng, KHÔNG THỂ chứng minh tính toàn vẹn nội dung chi tiết từng trường dữ liệu.';
    RAISE NOTICE '- Bắt buộc thực hiện kiểm tra đối chiếu nội dung chi tiết độc lập sau khi kết thúc migration.';
    RAISE NOTICE '====================================================================';
END $$;


COMMIT;
