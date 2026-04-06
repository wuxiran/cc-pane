# 启动任务

在 {{app_name}} 管理的项目中启动新的 Claude/Codex 实例。

参数: $ARGUMENTS

---

## MCP 工具

使用 `{{mcp_server_name}}` MCP 服务器的以下工具：

| 工具 | 用途 |
|------|------|
| `list_projects` | 列出所有已注册项目 |
| `launch_task` | 启动 Claude/Codex 实例 |
| `get_task_status` | 查询任务状态 |
| `get_session_status` | 查询终端会话状态 |

---

## 流程

### 1. 确定目标项目

解析 `$ARGUMENTS`，提取项目路径或关键词。

若未指定项目：
1. 调用 `{{mcp_server_name}}.list_projects` 获取项目列表
2. 展示列表供用户选择

### 2. 确定任务内容

从 `$ARGUMENTS` 中提取 prompt 内容。

若未指定 prompt，询问用户要执行什么任务。

### 3. 启动

调用 `{{mcp_server_name}}.launch_task`：
- `projectPath`: 目标项目路径
- `prompt`: 任务描述
- `cliTool`（可选）: `claude` 或 `codex`
- `title`（可选）: 自定义标签名

> **长任务描述**：如果 prompt 内容较长（超过约 200 字），先将完整任务描述写入 `.ccpanes/prompts/<descriptive-name>.md` 文件，然后 prompt 只传短引用：`Read task from '<文件路径>' and execute it. Delete the file after reading.`

### WSL 项目说明

当目标项目路径为 WSL UNC 格式（如 `\\wsl.localhost\Ubuntu\home\user\repo`）时，
`launch_task` 会自动检测并以 WSL 模式启动，无需额外参数。

如果工作空间的 `defaultEnvironment` 为 `wsl`，即使项目路径是 Windows 本地路径，
也会自动转换为 WSL 远端路径启动。

### 4. 确认

返回的 `taskId` 和 `sessionId` 报告给用户。

可选：调用 `{{mcp_server_name}}.get_task_status` 确认启动成功。

---

## 示例

```
/ccpanes:launch-task 在 /path/to/project 中修复登录 bug
/ccpanes:launch-task projectPath=/home/user/app prompt="添加单元测试"
/ccpanes:launch-task               # 交互式选择项目和任务
```
