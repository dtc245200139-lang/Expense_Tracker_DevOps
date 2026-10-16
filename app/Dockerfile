# ==============================================================================
# DOCKERFILE - EXPENSE TRACKER NODE.JS WEB APP
# ==============================================================================
# Base image: Node.js 20 LTS Alpine (Nhẹ, giảm diện tích tấn công)
FROM node:20-alpine

# Thiết lập thư mục làm việc bên trong container
WORKDIR /app

# Thiết lập biến môi trường chuẩn cho Node.js production
ENV NODE_ENV=production

# Phân quyền thư mục /app cho user non-root 'node' có sẵn trong Alpine image
RUN chown -R node:node /app

# Copy các file định nghĩa dependency trước để tận dụng Docker layer cache
COPY --chown=node:node package*.json ./

# Cài đặt dependency chính xác từ package-lock.json bằng npm ci
# Chỉ cài production dependencies và dọn dẹp cache
RUN npm ci --omit=dev && npm cache clean --force

# Copy toàn bộ mã nguồn ứng dụng (loại trừ theo .dockerignore) và gán quyền cho user node
COPY --chown=node:node . .

# Chuyển sang user 'node' (UID: 1000) - Hardening Non-Root container
USER node

# Mở cổng 3000 cho ứng dụng
EXPOSE 3000

# Kiểm tra sức khỏe của container (Healthcheck) qua endpoint /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Lệnh khởi động server
CMD ["node", "server.js"]
