# Expense Tracker DevOps

Ứng dụng quản lý thu chi dùng Node.js, Express, EJS và PostgreSQL. Docker Compose dựng ứng dụng monolith, PostgreSQL, pgAdmin, Nginx HTTPS, Prometheus, Grafana, Loki, Promtail, cAdvisor và PostgreSQL Exporter.

## Yêu cầu

- Docker Desktop với Linux containers và Docker Compose V2.
- Windows PowerShell 5.1 hoặc PowerShell 7; OpenSSL có sẵn trong Git for Windows hoặc WSL để tạo secret/chứng chỉ.
- Cổng host 80, 443, 5050, 9090, 3001 và 3100 chưa bị chương trình khác sử dụng.

## Cài đặt an toàn

1. Tạo cấu hình cục bộ: `Copy-Item .env.example .env`.
2. Sửa `.env` với mật khẩu riêng, mạnh cho PostgreSQL, pgAdmin, Grafana; tạo `SESSION_SECRET` tối thiểu 32 byte. Ví dụ PowerShell: `$secret = openssl rand -hex 32` rồi điền giá trị vào `.env`. Không đưa `.env` vào Git.
3. Với database/volume đã có, không đổi `DB_USER`, `DB_PASSWORD` hoặc `DB_NAME` trước khi hiểu tác động: thay biến trong Compose không đổi thông tin đăng nhập trong data directory đã khởi tạo.
4. Nginx yêu cầu `nginx/certs/selfsigned.crt` và `nginx/certs/selfsigned.key`. Key riêng không được theo dõi Git. Để tạo bộ localhost mới bằng OpenSSL (ghi đè đúng hai tệp chứng chỉ này nếu bạn chủ động chọn làm mới):

   ```powershell
   openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout nginx/certs/selfsigned.key -out nginx/certs/selfsigned.crt -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
   ```

   Giữ private key ở máy demo, không commit. Trình duyệt sẽ cảnh báo chứng chỉ tự ký. HSTS không bật cho cấu hình localhost này.

## Database hiện có và migration đăng nhập

`app/init.sql` chỉ chạy tự động khi PostgreSQL khởi tạo data directory mới. Authentication dùng bảng `users`, `session` và `transactions.user_id`, được mô tả trong `app/migrations/001_auth_schema.sql`. Compose không tự chạy migration. Trên database hiện có, trước khi migrate phải xác minh schema, sao lưu và kiểm tra khả năng phục hồi backup trong một database riêng; không xóa volume. Migration giữ các giao dịch cũ không có chủ sở hữu (`user_id IS NULL`), không tự gán dữ liệu cũ cho tài khoản nào.

Nếu đã xác minh điều kiện và được phép bảo trì, lệnh thực thi thủ công nằm trong Git Bash/WSL:

```sh
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < app/migrations/001_auth_schema.sql
```

Không chạy lệnh này như bước khởi động thông thường và không áp dụng trước khi kiểm tra backup/schema.

## Khởi chạy và kiểm tra

```powershell
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Lệnh `up` giữ nguyên named volumes. Không dùng `docker compose down -v`, `docker volume prune` hay thao tác xóa volume để sửa lỗi ứng dụng.

- Website: <https://localhost> (chấp nhận cảnh báo self-signed chỉ trong môi trường local).
- pgAdmin: <http://127.0.0.1:5050>; máy chủ PostgreSQL cấu hình thủ công với host `postgres`, port `5432`, database/user theo `.env`.
- Prometheus: <http://127.0.0.1:9090>; vào Status → Targets, tất cả job phải `UP`.
- Grafana: <http://127.0.0.1:3001>; dùng thông tin đăng nhập đã đặt trong `.env`. Datasource Prometheus và Loki cùng dashboard `Expense Tracker Overview` được provision.
- Loki API: <http://127.0.0.1:3100/ready>.

Kiểm tra nhanh bằng PowerShell:

```powershell
curl.exe -k https://localhost/health
curl.exe http://localhost/nginx-health
curl.exe -k https://localhost/metrics
docker compose logs --tail 100 app postgres nginx prometheus grafana loki promtail postgres-exporter cadvisor
```

`/health` phải trả HTTP 200 và JSON báo database connected. Prometheus phải có target app, postgres-exporter và cadvisor ở trạng thái `UP`; Grafana cần hiển thị chuỗi dữ liệu trong các panel sau khi có scrape. Cần thử đăng ký, đăng nhập, đăng xuất, thêm/sửa/xóa giao dịch và xác nhận một tài khoản không xem/sửa giao dịch của tài khoản khác. Thao tác ghi thử chỉ nên dùng dữ liệu demo được phép.

## Demo logging: LogQL

Trong Grafana → Explore → datasource Loki, chọn thời gian vừa qua. Label `service` lấy từ Docker Compose metadata. Các truy vấn:

```logql
{service="app"}
{service="app"} |= "[HTTP]"
{service="postgres"}
```

Gửi một vài yêu cầu website trước khi truy vấn để sinh log mới. Truy vấn không có kết quả có thể do chưa có log trong khoảng thời gian chọn, Promtail chưa nhận container, hoặc label khác; xác minh trạng thái Promtail/Loki và chọn khoảng thời gian phù hợp.

## Runtime verification đã thực hiện

Ngày 23-10-2026, Docker Desktop 4.93.0 / Engine 29.8.1 đã chạy. `docker compose config --quiet` và `docker compose up -d --build` thành công; không xóa volumes. Cả 10 service ở trạng thái running; app, PostgreSQL, Nginx và cAdvisor có health `healthy` (các service còn lại không khai báo healthcheck riêng).

Đã xác minh HTTPS `/health` trả 200 với database connected, HTTP redirect 301, Nginx health trả 200, pgAdmin phản hồi 302 tới đăng nhập và container pgAdmin mở được TCP connection tới service `postgres`. Ảnh pgAdmin do bạn cung cấp hiển thị database `expense_tracker_db` và các bảng `categories`, `session`, `transactions`, `users`; chưa có file ảnh này trong `docs/images/` để chèn vào báo cáo. PostgreSQL có bảng `users`, `session` và cột `transactions.user_id`; không chạy migration. Đăng ký, đăng nhập, tạo/đọc/sửa/xóa giao dịch thử và logout/access control đều đạt. Giao dịch thử đã xóa qua ứng dụng; các tài khoản synthetic phục vụ kiểm tra vẫn được giữ trong database (không lưu thông tin xác thực trong tài liệu).

Prometheus trả `UP` cho cả bốn targets (Prometheus, app, PostgreSQL Exporter, cAdvisor). Query `http_requests_total`, `pg_stat_database_tup_returned` và `container_memory_working_set_bytes` đều trả series. Grafana health và datasource Prometheus/Loki đều `OK`; dashboard `Expense Tracker Overview` được API trả về với 5 panel. Loki `/ready` trả 200 và Promtail gửi log. Trong cửa sổ kiểm thử, ba truy vấn ở trên lần lượt trả log app, log HTTP app và log PostgreSQL.

Grafana có thêm một datasource Loki legacy trong persistent volume, bên cạnh datasource Loki provisioned. Cả hai datasource đều health `OK`; legacy datasource chưa bị xóa để bảo toàn cấu hình hiện có.

### Kết nối pgAdmin tới PostgreSQL

1. Mở `http://127.0.0.1:5050` và đăng nhập bằng `PGADMIN_DEFAULT_EMAIL` / `PGADMIN_DEFAULT_PASSWORD` trong file `.env` cục bộ.
2. Chọn **Add New Server**. Tab **General**: đặt tên `Expense Tracker Local`.
3. Tab **Connection**: Host `postgres`, Port `5432`, Maintenance database `${DB_NAME}`, Username `${DB_USER}`, Password `${DB_PASSWORD}` lấy từ `.env`. Bật **Save password** chỉ nếu máy demo là máy cá nhân tin cậy.
4. Save, mở server → Databases → database dự án → Schemas → public → Tables. Xác minh `users` và `transactions`; có thể dùng Query Tool với câu chỉ đọc `SELECT to_regclass('public.users'), to_regclass('public.transactions');`.

Ảnh pgAdmin bạn cung cấp xác nhận kết nối tới PostgreSQL và hiển thị database cùng các bảng. Các bước trên dùng để tái hiện kết nối trong buổi demo nếu cần; hãy lưu ảnh chụp thật vào `docs/images/` trước khi nộp báo cáo.

### Kiểm thử phân tách dữ liệu giữa hai tài khoản

Đã kiểm tra bằng hai tài khoản synthetic mới A/B và giao dịch có marker test. B không thấy giao dịch A trong danh sách; GET edit theo ID trực tiếp, POST update và POST delete của B đều trả 404. Sau các yêu cầu trái quyền, A vẫn đọc được dữ liệu nguyên vẹn; A tự xóa giao dịch thử qua ứng dụng. Không còn giao dịch theo marker test. Các tài khoản smoke-test có từ trước được kiểm tra theo số lượng trước khi tạo A/B; hiện có tổng cộng 6 tài khoản synthetic theo tiền tố kiểm thử. Không tài khoản nào bị xóa, và không lưu credentials vào tài liệu/log.

Các ảnh báo cáo cần chụp và lưu theo danh sách trong `docs/images/README.md`.

DOCX đã được kết xuất thử bằng LibreOffice thành PDF 15 trang; đã xem các trang 5, 10 và 15, bảng/chú thích nằm trong lề. Các khung ảnh vẫn là placeholder. Sau khi chèn ảnh thật, kết xuất và kiểm tra lại số trang vì kích thước ảnh có thể làm thay đổi phân trang.

## Test mã nguồn

```powershell
npm ci --prefix app
npm test --prefix app
```

Các test hiện có kiểm tra hành vi session/health cơ bản; chúng không thay thế kiểm thử CRUD, đăng nhập, migration hoặc xác minh runtime Docker.

## Xử lý lỗi thường gặp

- **Docker Engine pipe không tồn tại / không kết nối được:** mở Docker Desktop, chờ trạng thái Engine running, xác nhận đang dùng Linux containers và context `desktop-linux`; thử `docker version` rồi `docker compose ps`. Không reset Docker hoặc xóa volumes để xử lý lỗi kết nối.
- **Compose báo thiếu biến:** kiểm tra `.env` có đủ các khóa trong `.env.example`; không chia sẻ giá trị secret khi xin hỗ trợ.
- **PostgreSQL healthy nhưng app/auth lỗi:** volume cũ không chạy lại `init.sql`. Kiểm tra log app và schema hiện tại; xác minh backup trước khi xem xét migration auth. Không xóa volume.
- **Nginx không khởi động:** xác nhận cả `nginx/certs/selfsigned.crt` và `nginx/certs/selfsigned.key` tồn tại, key khớp cert, định dạng PEM đúng; không chép hoặc commit private key vào repo.
- **Prometheus target DOWN:** xem log service tương ứng và đảm bảo service cùng mạng Prometheus; app target là `/metrics`, exporter là `postgres-exporter:9187`, cAdvisor là `cadvisor:8080`.
- **Grafana panel hoặc LogQL trống:** xác nhận datasource, target/log collector khỏe, chọn khoảng thời gian phù hợp và tạo một request website để phát sinh log mới.

## Backup và restore

Backup có dữ liệu tài chính. Lưu tại nơi giới hạn quyền và mã hóa, không commit. Trước khi thay đổi database, tạo backup theo quy trình của môi trường, kiểm tra checksum và thử khôi phục vào database tách biệt. Không ghi đè dữ liệu hiện tại khi chưa có kế hoạch được duyệt. Các backup hiện có trong thư mục dự án được giữ nguyên.

## Kiến trúc và bảo mật

Browser → Nginx (80 redirect, 443 TLS) → Express/EJS. Express và PostgreSQL nằm trên các mạng Compose tách biệt; PostgreSQL chỉ ở backend, không publish cổng host. pgAdmin kết nối qua service DNS `postgres` và chỉ bind localhost. Prometheus scrape app `/metrics`, PostgreSQL Exporter và cAdvisor. Grafana đọc Prometheus/Loki. Promtail đọc metadata/log container qua Docker socket read-only và push đến Loki.

Ứng dụng container chạy non-root; mật khẩu/secret được cấp qua biến môi trường; session lưu PostgreSQL, cookie HttpOnly/SameSite và Secure khi chạy production qua HTTPS; route thay đổi trạng thái có CSRF, route auth có rate limit. Giao dịch được lọc theo `user_id`. Docker socket cấp quyền quan sát mạnh cho Promtail/cAdvisor; chỉ chạy trong môi trường tin cậy, giữ các cổng monitoring trên localhost. Chứng chỉ self-signed chỉ dành cho demo cục bộ.

## Báo cáo nộp bài (tối thiểu 10 trang)

Đã tạo báo cáo Word tại `docs/Bao_cao_Expense_Tracker_DevOps.docx`. Bản hiện tại được kết xuất bằng LibreOffice thành 15 trang ngày 23-10-2026, nhưng chưa hoàn chỉnh để nộp: thông tin sinh viên và ảnh demo thật vẫn còn placeholder. Sau khi bổ sung, cập nhật mục lục và kết xuất/kiểm tra lại số trang cuối cùng. Không dùng ảnh giả lập hoặc khẳng định trạng thái chưa kiểm chứng.

1. Bìa: tên trường/môn học, đề tài, sinh viên, mã số, giảng viên, ngày nộp.
2. Mục lục và danh sách hình/bảng.
3. Mục tiêu, phạm vi và yêu cầu đề bài.
4. Kiến trúc hệ thống, sơ đồ luồng request và Docker network.
5. Ứng dụng web, đăng ký/đăng nhập/session, CRUD và phân quyền theo người dùng.
6. PostgreSQL, pgAdmin, named volume, schema/migration và bảo toàn dữ liệu.
7. Docker Compose, quy trình build/run/healthcheck và kiểm thử.
8. Commit 1: Nginx reverse proxy, HTTPS, chứng chỉ và security headers.
9. Commit 2: Prometheus targets/exporters, Grafana datasource và dashboard.
10. Commit 3: pipeline Promtail → Loki và ba truy vấn LogQL có kết quả.
11. Hardening, giới hạn bảo mật còn lại và phương án backup/restore.
12. Kết quả kiểm thử, hướng dẫn tái triển khai, kết luận và công việc còn lại.

Vị trí ảnh cần chèn: **[Hình 1 — Trang chủ sau đăng nhập]**, **[Hình 2 — CRUD giao dịch]**, **[Hình 3 — pgAdmin kết nối PostgreSQL]**, **[Hình 4 — HTTPS/Nginx và chứng chỉ]**, **[Hình 5 — Prometheus Targets đều UP]**, **[Hình 6 — Grafana dashboard có dữ liệu]**, **[Hình 7 — Loki Explore với ba truy vấn LogQL]**, **[Hình 8 — Docker Compose services/health]**. Mỗi ảnh cần chú thích, ngày chụp và giải thích kết quả.

## Git và phát hành

Repository hiện dùng nhánh `master` và remote `origin`. Không commit `.env`, `*.key`, backup SQL, log hoặc dữ liệu người dùng. Xem `git status` trước khi commit; commit/push do chủ dự án thực hiện sau khi duyệt thay đổi.
