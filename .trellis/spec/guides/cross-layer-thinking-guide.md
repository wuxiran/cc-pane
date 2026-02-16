# Cross-Layer Thinking Guide (CC-Panes)

> 在实现跨层功能前，先理清数据流。

---

## CC-Panes Layer Map

```
┌─────────────────────────────────────────────────┐
│  Layer 1: React Component                       │
│  (UI rendering, event handling)                 │
├─────────────────────────────────────────────────┤
│  Layer 2: Zustand Store                         │
│  (state management, caching)                    │
├─────────────────────────────────────────────────┤
│  Layer 3: Frontend Service                      │
│  (invoke() calls, error mapping)                │
├══════════════ Tauri IPC Boundary ═══════════════┤
│  Layer 4: Tauri Command                         │
│  (input validation, State extraction)           │
├─────────────────────────────────────────────────┤
│  Layer 5: Rust Service                          │
│  (business logic, orchestration)                │
├─────────────────────────────────────────────────┤
│  Layer 6: Repository                            │
│  (SQL queries, data access)                     │
├─────────────────────────────────────────────────┤
│  Layer 7: SQLite / File System / PTY            │
│  (persistent storage, processes)                │
└─────────────────────────────────────────────────┘
```

---

## The IPC Boundary (Layer 3 ↔ Layer 4)

这是最容易出错的边界：

| 问题 | 原因 | 解决 |
|------|------|------|
| 字段名不匹配 | Rust snake_case vs TS camelCase | `serde(rename_all)` |
| 类型不匹配 | `Option<T>` vs `T \| undefined` | 统一用 `T \| null` |
| 命令名拼写错误 | invoke 字符串不类型安全 | Service 层封装 |
| 错误处理遗漏 | invoke 返回 Promise | try/catch 在 Service 层 |

---

## Before Implementing Cross-Layer Features

### Step 1: Map the Data Flow

```
User Action → Component → Store → Service → invoke('command') →
→ Command(validate) → RustService(logic) → Repo(SQL) →
→ Data → serialize → TS → Store update → Component rerender
```

### Step 2: Check Each Boundary

对每个 `→`：
- 数据格式是否匹配？
- 错误如何传播？
- 是否有 null/undefined 处理？

### Step 3: Verify Type Alignment

```bash
# Check Rust models
grep -r "pub struct" src-tauri/src/models/

# Check TS types
grep -r "interface" src/types/

# Check invoke calls
grep -r "invoke(" src/services/

# Check command definitions
grep -r "#\[tauri::command\]" src-tauri/src/commands/
```

---

## Checklist

Before implementing:
- [ ] 画出完整数据流（从 UI 到 DB 再回来）
- [ ] 识别所有层边界
- [ ] 确认每个边界的数据格式
- [ ] 确认错误处理策略

After implementing:
- [ ] 运行 `/ccbook:check-tauri-bridge`
- [ ] 测试边界情况（null, empty, invalid）
- [ ] 验证错误消息用户友好
