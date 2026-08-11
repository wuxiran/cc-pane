---
name: ccpanes-workspace
description: Manage {{app_name}} workspaces via MCP — list / show / create workspace, add project, archive (reversible soft-delete), fix workspace path, scan a directory to bulk-import Git repos. Use when user says "工作空间"、"新建 workspace"、"扫一下这个目录"、"把项目加进来"、"归档工作空间"、"整理工作空间"、"workspace list"、"import projects"、"scan for repos"、"archive workspace"。Permanent deletion (delete workspace / remove project) must still be done in the {{app_name}} UI — MCP only offers the reversible archive.
---

# 工作空间管理

参数: $ARGUMENTS

## 决策树

| 用户在做什么 | 调用 |
|---|---|
| 看有哪些工作空间 | `list_workspaces` |
| 看某个工作空间的项目 | `get_workspace(workspaceName)` |
| 新建工作空间 | `create_workspace(name, path?)` |
| 把已有项目加进去 | `add_project_to_workspace(workspaceName, projectPath)` |
| 一个目录里有一堆 git repo，批量导入 | `scan_directory(path)` → 确认 → `create_workspace` + 循环 `add_project_to_workspace` |
| 列出所有已注册项目 | `list_projects` |
| 工作空间加错了 / 重复了 / 不用了 | `set_workspace_archived(workspaceName, archived=true)` |
| 项目加错了 | `set_workspace_project_archived(workspaceName, projectId, archived=true)` |
| 找回归档的东西 | `list_workspaces(includeArchived=true)` → `set_workspace_archived(..., archived=false)` |
| 工作空间路径填错了 / 没填 | `update_workspace_path(workspaceName, path)` |

## 子命令快捷映射

```
list                            → list_workspaces
show <name>                     → get_workspace
create <name> [--path <p>]      → create_workspace
add <ws> <project>              → add_project_to_workspace
archive <ws>                    → set_workspace_archived(archived=true)
restore <ws>                    → set_workspace_archived(archived=false)
set-path <ws> <path>            → update_workspace_path
scan <dir>                      → scan_directory + 询问 + 批量 add
projects                        → list_projects
```

## 归档 vs 删除

**归档是逻辑删除，可逆**：只给 workspace.json 打一个 `archivedAt` 时间戳，不删注册文件、
不动磁盘上的项目目录、不终止正在跑的会话。列表默认不再返回它，侧边栏也默认隐藏
（筛选栏的「显示已归档」可以调出来，右键即可恢复）。因为可逆，所以敢开放给 MCP。

**硬删除仍然只在 UI**：`delete_workspace` / `remove_project` 不可撤回，没有对应 MCP 工具。
用户说"删掉这个工作空间"时，默认理解为归档；除非他明确要求"彻底删除/不要了/永久删除"，
那时告诉他去 UI 右键删除。

归档一个仍有在途派工的工作空间不会被拒绝，但返回值里会带 `warning` 与
`unfinishedBindings` —— 归档不终止会话，要真停请用 `kill_session`。

## 注意

- **彻底删除**工作空间 / 移除项目 / 重命名 → 让用户在 {{app_name}} UI 操作，**不要试图通过 MCP 完成**；
  可逆的归档用上面的工具即可。
- 文件系统变更会被 {{app_name}} 自动监听同步。
- 迁移工作空间到新目录或 WSL → 用 `workspace-migrate` skill。
