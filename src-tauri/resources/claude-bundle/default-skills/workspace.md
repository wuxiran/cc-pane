---
name: ccpanes-workspace
description: Manage {{app_name}} workspaces via MCP — list / show / create workspace, add project, scan a directory to bulk-import Git repos. Use when user says "工作空间"、"新建 workspace"、"扫一下这个目录"、"把项目加进来"、"workspace list"、"import projects"、"scan for repos"。Destructive operations (delete workspace / remove project) must be done in the {{app_name}} UI, not via this skill.
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

## 子命令快捷映射

```
list                            → list_workspaces
show <name>                     → get_workspace
create <name> [--path <p>]      → create_workspace
add <ws> <project>              → add_project_to_workspace
scan <dir>                      → scan_directory + 询问 + 批量 add
projects                        → list_projects
```

## 注意

- 删除工作空间 / 移除项目 / 重命名 → 让用户在 {{app_name}} UI 操作，**不要试图通过 MCP 完成**。
- 文件系统变更会被 {{app_name}} 自动监听同步。
- 迁移工作空间到新目录或 WSL → 用 `workspace-migrate` skill。
