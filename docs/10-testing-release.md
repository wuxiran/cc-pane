# 阶段 10：测试

## 目标

编写单元测试、集成测试，配置 CI/CD。

## 状态

🔨 部分完成

## 任务清单

- [ ] Rust 后端单元测试（services 层）
- [ ] Rust 后端集成测试（commands 层）
- [ ] 前端组件测试（Vitest + React Testing Library）
- [ ] E2E 测试（Tauri 测试框架或 Playwright）
- [x] 配置 GitHub Actions CI (`.github/workflows/ci.yml`)
- [x] 配置 cargo clippy + cargo fmt 检查
- [x] 配置 tsc 类型检查

## 测试目录结构

```
src-tauri/
├── src/
│   └── services/
│       └── xxx_service.rs      # 内含 #[cfg(test)] mod tests
└── tests/                      # 集成测试
    └── integration_test.rs

src/
└── __tests__/                  # 前端测试（可选）
    └── xxx.test.ts
```

## CI 配置

使用 GitHub Actions，跨平台矩阵构建（Windows / macOS / Linux）。

### 关键检查项

| 检查项 | 命令 | 说明 |
|--------|------|------|
| Rust 测试 | `cargo test` | 单元测试 + 集成测试 |
| Rust Lint | `cargo clippy -- -D warnings` | 代码质量检查 |
| Rust 格式 | `cargo fmt --all -- --check` | 代码格式检查 |
| TS 类型检查 | `npx tsc --noEmit` | 前端类型安全 |
| 前端测试 | `npx vitest run` | 组件测试（配置后） |

### GitHub Actions 工作流概要

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - name: Install Rust
        uses: dtolnay/rust-action@stable
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: lts/*
      - name: Install dependencies (Ubuntu)
        if: matrix.os == 'ubuntu-latest'
        run: sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
      - run: cargo test --manifest-path src-tauri/Cargo.toml
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
      - run: cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
      - run: npm ci && npx tsc --noEmit
```

## 下一步

完成阶段 10 后，参见 [阶段 11：Tauri GUI 基础](./11-tauri-gui-basic.md)。
