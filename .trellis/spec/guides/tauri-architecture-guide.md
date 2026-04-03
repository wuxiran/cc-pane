# Tauri Architecture Thinking Guide (CC-Panes)

> 新功能的架构决策指南

---

## Decision: Frontend vs Backend?

| 放前端 | 放后端 |
|--------|--------|
| UI 逻辑（布局、动画） | 文件系统操作 |
| 临时 UI 状态 | 数据库操作 |
| 表单验证（简单） | 进程管理（PTY、Git） |
| 纯计算（不涉及系统） | 系统 API 调用 |
| | 输入验证（安全相关） |

**原则**: 涉及系统资源的放后端，纯 UI 的放前端。

---

## Decision: New Command or Extend Existing?

新建命令当：
- 操作语义独立（CRUD 各自独立）
- 参数集完全不同
- 返回类型不同

扩展现有当：
- 只是增加一个可选参数
- 逻辑高度相似

---

## Decision: Event vs Command?

| 用 Command (invoke) | 用 Event (emit/listen) |
|---------------------|----------------------|
| 请求-响应模式 | 后端主动通知前端 |
| 前端发起 | 后端发起 |
| 需要返回值 | 不需要返回值 |
| 一对一 | 一对多 |

```rust
// Command: 前端请求，后端响应
#[tauri::command]
async fn get_project(id: String) -> Result<Project, String> { ... }

// Event: 后端主动通知
app.emit("terminal-output", payload)?;
```

---

## 7-Step Feature Flow

新功能开发遵循：

1. **Model** (`src-tauri/src/models/`) — Rust 数据模型 + `#[serde]`
2. **Repository** (`src-tauri/src/repository/`) — SQL CRUD
3. **Service (Rust)** (`src-tauri/src/services/`) — 业务逻辑
4. **Command** (`src-tauri/src/commands/`) — IPC 接口 + 在 `lib.rs` 注册
5. **Service (TS)** (`web/services/`) — invoke 封装
6. **Store** (`web/stores/`) — Zustand 状态
7. **Component** (`web/components/`) — UI

跳过不需要的步骤（如纯前端功能跳过 1-4）。

---

## Common Mistakes

1. **Command 过大** — 应该拆分，每个命令单一职责
2. **前端直接 invoke** — 必须经过 Service 层
3. **忘记注册命令** — `lib.rs` 的 `invoke_handler` 中必须添加
4. **忘记更新 TS 类型** — 修改 Rust model 后必须同步 `web/types/`
