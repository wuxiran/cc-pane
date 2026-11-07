# CC-Panes 无界面服务端（docs/111-multi-device.md）。
#
#   docker compose up -d
#   docker compose exec cc-panes-web cc-panes-web token create --name my-laptop
#
# 然后在桌面端「设备」里以“直连”方式添加 http://<host>:8080 并填入上面的令牌。
# 服务以 --require-token 运行：没有设备令牌（或已配置的网页密码）的请求一律拒绝。

# ============ Frontend ============
FROM node:20-bookworm AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ============ Server ============
FROM rust:1-bookworm AS builder
WORKDIR /app
COPY . .
COPY --from=frontend /app/dist ./dist
# .cargo/config.toml 把 target 放在仓库外；容器里固定回仓库内，便于下一阶段拷贝。
ENV CARGO_TARGET_DIR=/app/target
RUN cargo build --release -p cc-panes-web --no-default-features --features embed-dist

# ============ Runtime ============
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates procps git libssl3 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/cc-panes-web /usr/local/bin/

EXPOSE 8080
ENV CC_PANES_CWD=/workspace
ENV CCPANES_WEB_DATA_DIR=/data
VOLUME ["/data"]
WORKDIR /workspace

ENTRYPOINT ["cc-panes-web"]
CMD ["--require-token", "--host", "0.0.0.0", "--port", "8080", "--cwd", "/workspace"]
