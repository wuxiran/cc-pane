# Tauri IPC Design (CC-Panes)

> Tauri 命令设计规范

---

## Command Design Principles

### 1. Single Responsibility

每个命令只做一件事：

```rust
// BAD: 一个命令做太多
#[tauri::command]
async fn manage_project(action: String, id: String) -> Result<String, String> { ... }

// GOOD: 拆分为独立命令
#[tauri::command]
async fn create_project(name: String, path: String) -> Result<Project, String> { ... }

#[tauri::command]
async fn delete_project(id: String) -> Result<(), String> { ... }
```

### 2. Type Safety

使用强类型，不用 String 代替 enum：

```rust
// BAD
#[tauri::command]
async fn set_status(status: String) -> Result<(), String> { ... }

// GOOD
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ProjectStatus { Active, Archived }

#[tauri::command]
async fn set_status(status: ProjectStatus) -> Result<(), String> { ... }
```

### 3. Async for I/O

涉及 I/O 的命令必须用 async：
- 数据库操作
- 文件系统操作
- 进程执行（git, claude）

---

## Command Naming

| 操作 | 前缀 | 示例 |
|------|------|------|
| 查询单个 | `get_` | `get_project` |
| 查询列表 | `get_` / `list_` | `get_projects`, `list_workspaces` |
| 创建 | `create_` | `create_project` |
| 更新 | `update_` | `update_project` |
| 删除 | `delete_` | `delete_project` |
| 操作 | 动词 | `open_terminal`, `run_git_command` |

---

## Command Registration

所有命令必须在 `lib.rs` 中注册：

```rust
.invoke_handler(tauri::generate_handler![
    commands::project_commands::get_projects,
    commands::project_commands::create_project,
    // ... 新命令加在这里
])
```

---

## TS Service 封装

每个 Rust command 对应一个 TS service 函数：

```typescript
// src/services/projectService.ts
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '@/types';

export const projectService = {
  async getAll(workspaceId: string): Promise<Project[]> {
    return invoke<Project[]>('get_projects', { workspaceId });
  },

  async create(name: string, path: string): Promise<Project> {
    return invoke<Project>('create_project', { name, path });
  },
};
```

---

## Forbidden

- 组件中直接调用 `invoke()`
- Command 中写业务逻辑（放 Service）
- 不在 `lib.rs` 注册就使用命令
- 不做错误处理的 invoke 调用
