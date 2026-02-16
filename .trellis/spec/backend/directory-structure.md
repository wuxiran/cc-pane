# Backend Directory Structure (CC-Panes)

> Rust 后端代码组织规范

---

## Structure

```
src-tauri/src/
├── main.rs                     # 应用入口（Windows subsystem）
├── lib.rs                      # 命令注册 + 服务初始化入口
├── commands/                   # Tauri IPC 命令层
│   ├── mod.rs
│   ├── workspace_commands.rs   # 工作空间命令
│   ├── project_commands.rs     # 项目命令
│   ├── terminal_commands.rs    # 终端命令
│   ├── git_commands.rs         # Git 操作命令
│   ├── local_history_commands.rs
│   ├── hooks_commands.rs
│   ├── journal_commands.rs
│   ├── worktree_commands.rs
│   ├── provider_commands.rs
│   └── settings_commands.rs
├── services/                   # 业务逻辑层
│   ├── mod.rs
│   ├── workspace_service.rs
│   ├── project_service.rs
│   ├── terminal_service.rs
│   ├── history_service.rs
│   └── ...
├── repository/                 # 数据访问层
│   ├── mod.rs
│   ├── db.rs                   # 数据库初始化 + 表结构
│   ├── project_repo.rs
│   └── history_repo.rs
├── models/                     # 数据模型
│   ├── mod.rs
│   ├── project.rs
│   ├── workspace.rs
│   ├── terminal.rs
│   └── settings.rs
└── utils/                      # 工具模块
    ├── mod.rs
    ├── error.rs                # AppError + AppResult<T>
    └── app_paths.rs            # 应用路径管理
```

---

## Layer Responsibilities

| Layer | 职责 | 依赖 |
|-------|------|------|
| **commands/** | 接收 IPC 调用，参数验证，调用 Service | services/ |
| **services/** | 业务逻辑，编排 Repository 调用 | repository/, models/ |
| **repository/** | 数据库 CRUD，SQL 执行 | models/ |
| **models/** | 数据结构定义（Serialize/Deserialize） | 无 |
| **utils/** | 横切关注点（错误处理、路径） | 无 |

---

## Conventions

1. **一个文件一个模块**: 每个 command/service/repo 对应一个文件
2. **命令文件命名**: `{domain}_commands.rs`（如 `project_commands.rs`）
3. **服务文件命名**: `{domain}_service.rs`
4. **lib.rs 注册**: 新命令必须在 `lib.rs` 的 `invoke_handler` 中注册

---

## Forbidden

- 不要在 commands/ 中写业务逻辑（放 services/）
- 不要在 services/ 中写 SQL（放 repository/）
- 不要跨层访问（commands 不能直接访问 repository）
