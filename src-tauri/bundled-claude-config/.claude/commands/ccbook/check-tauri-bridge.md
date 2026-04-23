# Tauri 桥接一致性检查

检查 Rust Command 和 TypeScript Service 之间的接口是否同步。

---

## 执行步骤

### 1. 识别变更的桥接文件

```bash
git diff --name-only | grep -E "(commands/|services/|models/|types/)"
```

### 2. 对比 Rust 命令签名

对于每个变更的 Rust 命令文件 (`src-tauri/src/commands/*.rs`)：
- 提取 `#[tauri::command]` 函数签名
- 记录参数名、类型、返回值

### 3. 对比 TypeScript 服务调用

对于对应的 TS 服务文件 (`src/services/*.ts`)：
- 提取 `invoke()` 调用
- 记录命令名、参数、返回类型

### 4. 检查一致性

| 检查项 | 说明 |
|--------|------|
| 命令名匹配 | Rust `fn xxx` ↔ TS `invoke("xxx")` |
| 参数名匹配 | Rust `snake_case` ↔ TS `camelCase`（Tauri 自动转换） |
| 参数类型匹配 | `String` ↔ `string`, `Vec<T>` ↔ `T[]`, `Option<T>` ↔ `T \| null` |
| 返回类型匹配 | `AppResult<T>` ↔ `Promise<T>` |
| lib.rs 注册 | 命令是否在 `invoke_handler` 中注册 |

### 5. 检查类型定义

对比 `src-tauri/src/models/*.rs` 和 `src/types/*.ts`：
- 结构体字段 ↔ 接口字段
- `#[serde(skip_serializing_if)]` ↔ 可选字段 `?`
- 枚举变体 ↔ Union Type

### 6. 输出报告

列出所有不一致项及修复建议。
