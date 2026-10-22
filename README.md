# Expense Tracker DevOps

Ứng dụng quản lý thu chi dùng Node.js/Express, EJS và PostgreSQL. Docker Compose chạy ứng dụng, Nginx HTTPS, Prometheus, Grafana, Loki và Promtail.

## Yêu cầu

- Docker Desktop với Docker Compose V2
- OpenSSL để tạo secret phiên đăng nhập

## Cấu hình và chạy

1. Tạo file môi trường riêng:

   ```sh
   cp .env.example .env
   ```

   Trên PowerShell: `Copy-Item .env.example .env`. Điền mật khẩu mạnh cho PostgreSQL, pgAdmin và Grafana; tạo `SESSION_SECRET` bằng `openssl rand -hex 32` (ít nhất 32 byte). Không commit hoặc gửi file `.env`.

   Với database/volume đã tồn tại, giữ nguyên `DB_USER`, `DB_PASSWORD` và `DB_NAME` đang dùng. Sửa giá trị trong `.env` không tự đổi mật khẩu của PostgreSQL đã khởi tạo trước đó.

2. Kiểm tra cấu hình và khởi chạy:

   ```sh
   docker compose config --quiet
   docker compose up -d --build
   docker compose ps
   ```

   Các lệnh trên không xóa named volume. Không dùng `docker compose down -v` hoặc lệnh prune nếu cần bảo toàn database.

3. Mở ứng dụng tại `https://localhost`. Chứng chỉ đi kèm là self-signed dành cho phát triển cục bộ; trình duyệt sẽ cảnh báo. Khi triển khai thật, thay chứng chỉ và private key trong `nginx/certs/` bằng chứng chỉ hợp lệ.

pgAdmin được bind vào localhost tại cổng `PGADMIN_PORT` (mặc định 5050). Prometheus, Grafana và Loki cũng chỉ bind vào localhost.

## Database và migration

- `app/init.sql` chỉ được PostgreSQL chạy tự động khi khởi tạo data directory rỗng.
- `app/migrations/001_auth_schema.sql` là migration thủ công, không được Compose tự chạy. Trước khi chạy migration trên database hiện có, tạo và kiểm tra backup, xác minh schema/trạng thái migration và chạy trong cửa sổ bảo trì.
- Không chạy lại migration tùy tiện. Migration giữ `transactions.user_id IS NULL`; không tự gán chủ sở hữu cho dữ liệu cũ.
- Không xóa volume PostgreSQL để “sửa” schema hoặc khởi tạo lại dữ liệu.

Nếu đã xác minh migration chưa chạy và backup đã kiểm tra, chạy thủ công từ Git Bash/WSL:

```sh
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < app/migrations/001_auth_schema.sql
```

## Kiểm thử

```sh
cd app
npm ci
npm test
```

Kiểm tra trạng thái dịch vụ bằng `docker compose ps`; các endpoint health của ứng dụng, Prometheus, Grafana và Loki có thể dùng để chẩn đoán.

## Backup

Tạo bản dump SQL từ thư mục gốc dự án. Dùng Git Bash/WSL để giữ nguyên luồng byte của file khi dùng chuyển hướng:

```sh
stamp=$(date +%Y%m%d_%H%M%S)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' > "backup_expense_tracker_db_${stamp}.sql"
sha256sum "backup_expense_tracker_db_${stamp}.sql"
```

Giữ backup ở nơi có quyền truy cập hạn chế, mã hóa khi lưu/chuyển và kiểm tra checksum. Backup chứa dữ liệu tài chính; không commit vào Git. `.gitignore` đã bỏ qua file theo mẫu `backup_expense_tracker_db_*.sql`.

## Restore

Trước tiên kiểm tra backup bằng cách phục hồi vào một database trống riêng, không ghi đè database đang dùng. Ví dụ trong Git Bash/WSL:

```sh
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" expense_tracker_restore'
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d expense_tracker_restore' < backup_expense_tracker_db_YYYYMMDD_HHMMSS.sql
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d expense_tracker_restore -c "SELECT count(*) AS transactions, count(*) FILTER (WHERE user_id IS NULL) AS legacy_without_owner FROM transactions"'
```

Dùng tên database, tài khoản và file backup đúng với môi trường. Việc khôi phục vào database đang chạy có thể ghi đè hoặc trộn dữ liệu; cần dừng ghi, backup trạng thái hiện tại, xác minh bản phục hồi và có kế hoạch chuyển đổi rõ ràng trước khi làm. Không dùng `DROP DATABASE`, `down -v` hoặc ghi đè volume như một bước khôi phục mặc định.

## Monitoring và log

- Prometheus: `http://127.0.0.1:9090`
- Grafana: `http://127.0.0.1:3001`
- Loki API: `http://127.0.0.1:3100`

Prometheus thu thập metrics ứng dụng, PostgreSQL exporter và cAdvisor. Promtail gửi log container tới Loki.
