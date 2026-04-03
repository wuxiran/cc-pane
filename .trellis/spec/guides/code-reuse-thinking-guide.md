# Code Reuse Thinking Guide (CC-Panes)

> 写代码前先搜索，避免重复。

---

## The Rule

> **Before writing ANY utility/helper, search the codebase first.**

```bash
# Search frontend
rg "functionName" web/

# Search backend
rg "function_name" src-tauri/src/
```

---

## Common Reuse Opportunities in CC-Panes

### Frontend

| 场景 | 先检查 |
|------|--------|
| 日期格式化 | `web/utils/` 是否已有 |
| 路径处理 | `web/utils/` 或 `@tauri-apps/api/path` |
| ID 生成 | 已有 `crypto.randomUUID()` 模式 |
| Toast 通知 | 已有 `sonner` 组件 |
| 类名合并 | 已有 `cn()` from `web/lib/utils` |

### Backend

| 场景 | 先检查 |
|------|--------|
| 路径处理 | `utils/app_paths.rs` |
| 错误类型 | `utils/error.rs` (AppError) |
| UUID 生成 | 已有 `uuid` crate |
| 文件读写 | 现有 Service 中的模式 |

---

## When to Extract vs Inline

| 条件 | 决策 |
|------|------|
| 代码出现 1 次 | 内联 |
| 代码出现 2 次 | 考虑提取 |
| 代码出现 3+ 次 | 必须提取 |
| 代码 <3 行 | 通常内联 |
| 代码有复杂逻辑 | 提取并测试 |

---

## Forbidden

- 不要在不搜索的情况下创建新工具函数
- 不要在两个地方维护相同的类型定义
- 不要复制粘贴后"稍作修改"（提取参数化版本）
