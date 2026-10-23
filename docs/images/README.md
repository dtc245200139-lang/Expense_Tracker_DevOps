# Ảnh minh họa báo cáo

Lưu ảnh chụp màn hình thật từ máy demo vào thư mục này. Không dùng ảnh tạo giả, không chụp mật khẩu/session token, và che email/tên người dùng cùng dữ liệu tài chính cá nhân. Dùng PNG, chiều rộng khoảng 1400–1800 px, giữ tỷ lệ ảnh; không kéo méo ảnh khi chèn vào Word.

| Tên file | Vị trí trong DOCX | Nội dung cần thể hiện |
|---|---|---|
| `01-github-history.png` | Chương 1, Hình 1 | Repository, nhánh và commit history; không để lộ credential. |
| `02-architecture.png` | Chương 2, Hình 2 | Sơ đồ kiến trúc/network/ports/luồng web, metrics và log. Tự vẽ theo cấu hình thực tế. |
| `03-dashboard-user-a.png` | Chương 3, Hình 3 | Website sau đăng nhập bằng tài khoản demo; che thông tin nhận dạng. |
| `04-transactions-crud.png` | Chương 3, Hình 4 | Giao dịch demo trong danh sách sau thao tác CRUD. |
| `05-pgadmin-tables.png` | Chương 4, Hình 5 | pgAdmin đã kết nối, hiển thị database và bảng `users`, `transactions`. Chụp sau khi người dùng hoàn tất cấu hình UI. |
| `06-compose-health.png` | Chương 5, Hình 6 | Kết quả `docker compose ps`, các trạng thái running/healthy. |
| `07-nginx-https.png` | Chương 6, Hình 7 | Trình duyệt mở HTTPS local và endpoint health; cảnh báo self-signed có thể xuất hiện. |
| `08-prometheus-targets.png` | Chương 7, Hình 8 | Prometheus Status → Targets, bốn targets `UP`. |
| `09-grafana-dashboard.png` | Chương 7, Hình 9 | Dashboard Expense Tracker có các panel và chuỗi dữ liệu thực. |
| `10-loki-logql.png` | Chương 8, Hình 10 | Grafana Explore, datasource Loki, truy vấn LogQL và log trả về. |
| `11-isolation-denied.png` | Phần bổ sung quyền A/B | Tài khoản B nhận 404 khi mở/sửa/xóa ID của A; không chụp email hoặc cookie. |
| `12-isolation-owner.png` | Phần bổ sung quyền A/B | Tài khoản A vẫn thấy giao dịch của mình sau các request trái quyền từ B. |

## Chèn vào Word

Thay từng khung `[CHÈN ẢNH CHỤP THỰC TẾ TẠI ĐÂY]` trong DOCX bằng ảnh tương ứng, giữ bảng một ô làm khung, đặt ảnh vừa chiều rộng vùng văn bản (khoảng 6.0–6.3 inch), bật **Lock aspect ratio**, và giữ chú thích ngay dưới ảnh. Không kéo ảnh vượt lề. Sau khi chèn, cập nhật mục lục và kiểm tra lại tổng số trang trong Microsoft Word.

Các ảnh chưa được chụp trong workspace; danh sách này chỉ là hướng dẫn, không phải bằng chứng runtime.
