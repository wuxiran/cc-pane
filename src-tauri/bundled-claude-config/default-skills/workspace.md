# 工作空间管理

通过 MCP 工具管理 {{app_name}} 的工作空间：创建、查看、添加项目、扫描导入。

参数: $ARGUMENTS

---

## MCP 工具

使用 `{{mcp_server_name}}` MCP 服务器的以下工具：

| 工具 | 用途 |
|------|------|
| `list_workspaces` | 列出所有工作空间 |
| `get_workspace` | 查看工作空间详情 |
| `create_workspace` | 创建新工作空间 |
| `add_project_to_workspace` | 添加项目到工作空间 |
| `scan_directory` | 扫描目录发现 Git 仓库 |
| `list_projects` | 列出所有已注册项目 |

---

## 子命令

解析 `$ARGUMENTS`，执行对应操作：

### `list` — 列出所有工作空间

调用 `{{mcp_server_name}}.list_workspaces`，以表格形式展示。

### `show <name>` — 查看工作空间详情

调用 `{{mcp_server_name}}.get_workspace`（参数: `workspaceName`）。

### `create <name> [--path <path>]` — 创建工作空间

调用 `{{mcp_server_name}}.create_workspace`（参数: `name`, `path`）。

### `add <workspace> <project-path>` — 添加项目

调用 `{{mcp_server_name}}.add_project_to_workspace`（参数: `workspaceName`, `projectPath`）。

### `scan <directory>` — 扫描并批量导入

1. 调用 `{{mcp_server_name}}.scan_directory`（参数: `path`）发现 Git 仓库
2. 展示发现的仓库列表
3. 询问用户是否创建工作空间并导入
4. 若确认：
   - 调用 `create_workspace` 创建工作空间
   - 逐个调用 `add_project_to_workspace` 添加项目

### `projects` — 列出所有项目

调用 `{{mcp_server_name}}.list_projects`，以表格形式展示。

---

## 示例

```
/ccpanes:workspace list
/ccpanes:workspace show my-workspace
/ccpanes:workspace create my-project --path /home/user/projects
/ccpanes:workspace add my-workspace /home/user/app
/ccpanes:workspace scan /home/user/projects
/ccpanes:workspace projects
/ccpanes:workspace           # 显示帮助
```

---

## 注意

- 破坏性操作（删除工作空间/移除项目）需在 {{app_name}} UI 中手动执行
- 修改会通过文件系统监控自动同步到 {{app_name}} UI
