# Backend Quality Guidelines (CC-Panes)

> Clippy + rustfmt + 代码标准

---

## Clippy Rules

项目使用 `cargo clippy -- -D warnings`（警告即错误）。

常见需注意的 lint:

| Lint | 说明 |
|------|------|
| `clippy::unwrap_used` | 不要用 unwrap（用 ? 或 map_err） |
| `clippy::expect_used` | 不要用 expect（同上） |
| `clippy::needless_return` | 不要显式 return（用表达式） |
| `clippy::redundant_clone` | 不要多余的 clone |
| `clippy::single_match` | 单分支 match 用 if let |

---

## Formatting

```bash
cargo fmt --all -- --check    # 检查格式
cargo fmt --all               # 自动格式化
```

---

## File Size Limits

| 类型 | 建议 | 最大 |
|------|------|------|
| Command 文件 | <200 行 | 400 行 |
| Service 文件 | <300 行 | 600 行 |
| Repository 文件 | <200 行 | 400 行 |
| Model 文件 | <100 行 | 200 行 |

---

## Derive Conventions

所有公开数据模型必须 derive：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    // ...
}
```

---

## Verification Commands

```bash
cargo check --workspace              # 编译检查
cargo clippy --workspace -- -D warnings  # Lint
cargo fmt --all -- --check           # 格式检查
cargo test --workspace               # 测试
```

---

## Forbidden

- `unwrap()` / `expect()` 在非测试代码
- `unsafe` 块（除非有充分理由和注释）
- `#[allow(clippy::...)]` 不加说明
- 忽略 `Result` 返回值（用 `let _ =` 需注释原因）
