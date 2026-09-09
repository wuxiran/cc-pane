---
name: ccpanes-workspace
description: Manage CC-Panes workspaces: list, create, add project, archive, fix path, bulk-import repos. 触发词：工作空间、扫一下这个目录、把项目加进来、新建 workspace、归档工作空间。查询走 MCP，写操作走 cc-panes-ctl；永久删除只能在 UI 里做。
---

# 工作空间管理

参数: $ARGUMENTS

只读查询（`list_workspaces` / `get_workspace` / `list_projects`）在会话 MCP 里直接调；
**写操作不在会话 MCP 里**，用 shell 敲 `cc-panes-ctl`（路径在 `$CC_PANES_CTL`，详见 `ccpanes-admin` skill）：

```bash
"$CC_PANES_CTL" --json call <tool> --arg k=v …      # 或 --json '{…}'
"$CC_PANES_CTL" --json tools --schema <tool>        # 不确定参数时先看 schema
```

## 决策树

| 用户在做什么 | 调用 |
|---|---|
| 看有哪些工作空间 | MCP `list_workspaces` |
| 看某个工作空间的项目 | MCP `get_workspace(workspaceName)` |
| 新建工作空间 | ctl `call create_workspace --arg name=<n> [--arg path=<p>]` |
| 把已有项目加进去 | ctl `call add_project_to_workspace --arg workspaceName=<ws> --arg projectPath=<p>` |
| 一个目录里有一堆 git repo，批量导入 | ctl `call scan_directory --arg path=<dir>` → 确认 → `create_workspace` + 循环 `add_project_to_workspace` |
| 列出所有已注册项目 | MCP `list_projects` |
| 工作空间加错了 / 重复了 / 不用了 | ctl `call set_workspace_archived --arg workspaceName=<ws> --arg archived=true` |
| 项目加错了 | ctl `call set_workspace_project_archived --arg workspaceName=<ws> --arg projectId=<id> --arg archived=true` |
| 找回归档的东西 | MCP `list_workspaces(includeArchived=true)` → ctl `set_workspace_archived … --arg archived=false` |
| 工作空间路径填错了 / 没填 | ctl `call update_workspace_path --arg workspaceName=<ws> --arg path=<p>` |

## 子命令快捷映射

```
list                            → MCP list_workspaces
show <name>                     → MCP get_workspace
create <name> [--path <p>]      → ctl call create_workspace
add <ws> <project>              → ctl call add_project_to_workspace
archive <ws>                    → ctl call set_workspace_archived --arg archived=true
restore <ws>                    → ctl call set_workspace_archived --arg archived=false
set-path <ws> <path>            → ctl call update_workspace_path
scan <dir>                      → ctl call scan_directory + 询问 + 批量 add
projects                        → MCP list_projects
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
