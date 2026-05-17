---
name: ccpanes-launch-task
description: Launch a new Claude or Codex CLI session in a {{app_name}}-managed project. Use when the user says "启动 Claude/Codex"、"开个新窗口"、"在 X 项目跑个任务"、"分屏"、"new session"、"open a Codex in"、"run this in another instance"。Also use when user wants to dispatch a long-form prompt to a fresh CLI instead of doing it inline. Supports local / WSL / SSH runtimes via `runtimeKind`.
---

# 启动任务

参数: $ARGUMENTS

## 流程

1. **确定项目** — 解析 `$ARGUMENTS`。未指定时调用 `{{mcp_server_name}}.list_projects` 让用户选。
2. **确定 prompt** — 从 `$ARGUMENTS` 提取；超过 200 字时先写到 `.ccpanes/prompts/<name>.md`，prompt 改为 `Read task from '<path>' and execute it. Delete the file after reading.`（避免长 prompt 黑屏）。
3. **启动** — 调用 `{{mcp_server_name}}.launch_task`：
   - `projectPath`、`prompt` 必填
   - `cliTool`: `claude` / `codex`（可选）
   - `runtimeKind`: `local` / `wsl` / `ssh`（可选，优先级高于 workspace 默认环境）
   - `title`（可选）
4. **回报** — 返回 `taskId` / `sessionId`；可选 `get_task_status` 确认。

## WSL 项目

- 路径为 `\\wsl.localhost\...` UNC 时自动按 WSL 启动，无需参数。
- workspace `defaultEnvironment=wsl` 时，Windows 路径会自动转换为 WSL 远端路径。
- 用户明确"在 Windows 本机"时传 `runtimeKind: "local"` 覆盖。
- resume 历史会话时若不传 `runtimeKind`，优先使用历史的 runtimeKind，避免被 workspace 默认覆盖。

详细环境分支与路径转换见 `launch-task.reference.md`（仅在出现非常规路径时阅读）。

## 示例

```
/ccpanes:launch-task 在 /path/to/project 中修复登录 bug
/ccpanes:launch-task projectPath=/home/user/app prompt="添加单元测试"
/ccpanes:launch-task                       # 交互式
```
