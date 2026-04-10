当用户要求你在某个项目中启动 Claude Code 执行任务时，使用 ccpanes MCP 工具。

## 可用 MCP 工具（12 个）

### 编排

| 工具 | 用途 |
|------|------|
| `launch_task` | 在项目中启动 Claude/Codex 实例（参数: projectPath, prompt 或 resumeId, cliTool?, providerId?, workspaceName?, title?, paneId?） |
| `list_projects` | 列出所有已注册项目 |
| `get_task_status` | 查询任务状态（参数: taskId） |

### 工作空间

| 工具 | 用途 |
|------|------|
| `list_workspaces` | 列出所有工作空间概览 |
| `get_workspace` | 获取工作空间详情（参数: workspaceName） |
| `create_workspace` | 创建新工作空间（参数: name, path?） |
| `add_project_to_workspace` | 添加项目到工作空间（参数: workspaceName, projectPath） |
| `scan_directory` | 扫描目录发现 Git 仓库和 worktree（参数: path） |

### 待办任务

| 工具 | 用途 |
|------|------|
| `query_todos` | 查询待办列表（参数: status?, priority?, scope?, scopeRef?, search?, limit?） |
| `create_todo` | 创建待办（参数: title, description?, priority?, scope?, scopeRef?, tags?） |
| `update_todo` | 更新待办（参数: id, title?, status?, priority?, description?） |

### Skill

| 工具 | 用途 |
|------|------|
| `list_skills` | 列出项目可用 Skill（参数: projectPath） |

## 典型工作流

### 启动任务

1. **查看可用项目**：调用 `ccpanes.list_projects`
2. **启动任务**：调用 `ccpanes.launch_task`（参数: projectPath, prompt；如需 Codex 传 `cliTool="codex"`）
3. **检查状态**：调用 `ccpanes.get_task_status`（参数: taskId）

### 从目录批量导入

1. **扫描目录**：调用 `ccpanes.scan_directory`（参数: path）→ 发现 Git 仓库
2. **创建工作空间**：调用 `ccpanes.create_workspace`（参数: name, path?）
3. **添加项目**：逐个调用 `ccpanes.add_project_to_workspace`（参数: workspaceName, projectPath）
4. **启动任务**：在各项目中调用 `ccpanes.launch_task`

### 用 Todo 跟踪多 Agent 进度

1. **创建任务**：调用 `ccpanes.create_todo` 记录每个子任务
2. **启动 Agent**：调用 `ccpanes.launch_task` 在各项目中执行
3. **更新进度**：调用 `ccpanes.update_todo` 将状态改为 in_progress / done

## 备选：curl 命令

如果 MCP 工具不可用，使用环境变量 `CC_PANES_API_PORT` 和 `CC_PANES_API_TOKEN`：

```bash
# 查看可用项目
curl -s -H "Authorization: Bearer $CC_PANES_API_TOKEN" \
  http://localhost:$CC_PANES_API_PORT/api/projects

# 启动任务
curl -s -X POST \
  -H "Authorization: Bearer $CC_PANES_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/path/to/project", "prompt": "任务描述"}' \
  http://localhost:$CC_PANES_API_PORT/api/launch-task

# 检查任务状态
curl -s -H "Authorization: Bearer $CC_PANES_API_TOKEN" \
  http://localhost:$CC_PANES_API_PORT/api/task-status/{taskId}
```

## 注意事项

- 只能在已注册的项目路径上启动任务（白名单校验）
- `launch_task` 的 `cliTool` 可选值为 `claude` 或 `codex`；默认 `claude`
- 当项目路径是 WSL UNC 格式（如 `\\wsl.localhost\Ubuntu\home\user\repo`）时，`launch_task` 会自动检测并以 WSL 模式启动，无需额外参数
- 如果工作空间的 `defaultEnvironment` 为 `wsl`，即使项目路径是 Windows 本地路径，也会自动转换为 WSL 远端路径启动
- 每个任务会在 CC-Panes 中自动创建新的标签页
- Claude 启动后会自动注入 prompt，无需手动输入
- 可以通过 `get_task_status` 轮询任务进度
- 破坏性操作（删除工作空间/项目/待办）不暴露为 MCP，需手动在 UI 中操作
