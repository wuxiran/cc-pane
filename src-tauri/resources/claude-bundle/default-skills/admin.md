---
name: ccpanes-admin
description: Manage {{app_name}} itself via cc-panes-ctl: workspaces, launch profiles, shared MCP, runners, media, browser, files. 触发词：建工作空间、加项目、改启动档、开共享 MCP、runner、管理 CC-Panes。任务要改的是 CC-Panes 配置而不是代码时用。
---

# 用 cc-panes-ctl 管理 {{app_name}}

会话里的 `{{mcp_server_name}}` MCP 只有 core 工具（会话 / 派发 / 编排 / memory）。
管理台工具不在里面——不是没有，而是走 CLI：`cc-panes-ctl call <tool>` 直连 orchestrator 的全量面 `/mcp-full`。

## 怎么调

```bash
# 二进制路径在环境变量里（WSL 里也有，走 interop）
"$CC_PANES_CTL" --json tools --schema <tool>          # 看某个工具的参数 schema
"$CC_PANES_CTL" --json call <tool> --arg k=v --arg k2=v2
"$CC_PANES_CTL" --json call <tool> --json '{"k":"v","nested":{"a":1}}'
```

- `--json` 放在子命令前面，输出机器可读 JSON。
- `--arg k=v` 会按 schema 类型转换（boolean / integer / number / string）；数组、对象或多行文本用 `--json`。
- 连接信息来自会话环境变量（`CC_PANES_API_BASE_URL` / `CC_PANES_API_PORT` / `CC_PANES_API_TOKEN`），不用传。
- 第一次用某个工具先 `tools --schema <tool>` 看参数，不要猜。全部工具名：`"$CC_PANES_CTL" tools`。
- 每次调用是一次 shell 命令；非 YOLO 会话会弹权限确认，属正常。

## 想做什么 → 调哪个

| 想做什么 | 工具 |
|---|---|
| 看工作空间 / 项目（core 里也有） | `list_workspaces` `get_workspace` `list_projects` |
| 新建工作空间、加项目 | `create_workspace(name, path?)` `add_project_to_workspace(workspaceName, projectPath)` |
| 一个目录里一堆 repo 批量导入 | `scan_directory(path)` → 确认 → `create_workspace` + 循环 `add_project_to_workspace` |
| 归档 / 恢复（可逆，UI 才能永久删） | `set_workspace_archived(workspaceName, archived)` `set_workspace_project_archived(workspaceName, projectId, archived)` |
| 工作空间路径填错 | `update_workspace_path(workspaceName, path)` |
| 启动配置 | `list_launch_profiles`（core 有）`create_runtime_config` `bind_workspace_launch_profile` `delete_launch_profile` |
| CLI 启动覆盖 | `list_cli_launcher_overrides` `set_cli_launcher_override` `clear_cli_launcher_override` |
| 工作空间 / 项目层 MCP（mcp.json） | `list_mcp_servers` `get_mcp_server` `upsert_mcp_server` `remove_mcp_server` |
| 共享 MCP 服务库 | `get_shared_mcp_config` `get_shared_mcp_status` `upsert_shared_mcp_server` `start_shared_mcp_server` `stop_shared_mcp_server` `restart_shared_mcp_server` `remove_shared_mcp_server` `import_shared_mcp_from_claude` |
| dev / build 进程（runner） | `list_runner_profiles` `upsert_runner_profile` `delete_runner_profile` `plan_runner_launch` `start_runner` `stop_runner` `list_active_runners` `kill_runner_pid` `list_port_conflicts` `list_workspace_port_reservations` |
| 媒体生成 | `create_media_node` `create_media_run` `get_media_run` `retry_media_run` `cancel_media_run` |
| 内置浏览器 | `open_browser_tab` `browser_navigate` `browser_click` `browser_evaluate` `browser_screenshot` |
| 在 {{app_name}} 里开文件 / 目录 | `open_file` `close_file` `list_open_files` `open_folder` |
| Cursor 联动 | `cursor_bridge(action=init\|context\|do\|status\|model\|session, …)` |
| 不建 TaskBinding 的裸启动 | `launch_task`（会话内派任务请用 core 的 `dispatch_task`） |

## 例子

```bash
"$CC_PANES_CTL" --json call scan_directory --arg path=D:/repos
"$CC_PANES_CTL" --json call create_workspace --arg name=erp --arg path=D:/repos/erp
"$CC_PANES_CTL" --json call add_project_to_workspace --arg workspaceName=erp --arg projectPath=D:/repos/erp/api
"$CC_PANES_CTL" --json call start_shared_mcp_server --arg name=context7
"$CC_PANES_CTL" --json call upsert_mcp_server --json '{"workspaceName":"erp","name":"docs","command":"npx","args":["-y","docs-mcp"],"env":{}}'
```

## 注意

- 删除工作空间 / 移除项目 / 重命名没有 MCP 工具，让用户在 UI 做；"删掉"默认理解为归档。
- 归档仍有在途派工的工作空间不会被拒，但返回 `warning` + `unfinishedBindings`；要停会话用 core 的 `kill_session`。
- WSL 会话里 `$CC_PANES_CTL` 已翻成 `/mnt/...` 路径，需要 Windows interop 开着；报 "cannot execute binary" 就说明 interop 关了，让用户在本机会话做。
