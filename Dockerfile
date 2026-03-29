# ============ Build stage ============
FROM rust:1.82-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release -p cc-panes-web

# ============ Runtime stage ============
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates procps && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/cc-panes-web /usr/local/bin/

EXPOSE 8080
ENV CC_PANES_CWD=/workspace
WORKDIR /workspace

ENTRYPOINT ["cc-panes-web"]
CMD ["--port", "8080", "--cwd", "/workspace"]
