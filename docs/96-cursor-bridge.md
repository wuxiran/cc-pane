# 96 — CC-Panes Cursor Bridge

> 状态：0.12.10 落地。产品面参考 [Vanyangyang/cursor-bridge](https://github.com/Vanyangyang/cursor-bridge)，实现走官方 `cursor-agent` CLI，**不走 CDP**。

## 为什么不搬 CDP

参考项目用 `--remote-debugging-port=9223` 填 Cursor Agents 输入框、爬 React fiber。那套：

- 只跟最新 Cursor，Windows-only
- 与 `cursor-handoff` 红线同族（非公开 UI 面）
- 身份是 IDE（`ide`），不是 CC-Panes 已编排的 CLI（`cli`）
- `minimal` 会把用户自己的 Cursor 窗口藏掉

CC-Panes 借它的会话契约和证据形状，用已有 `dispatch` / `create_launch_session` / `cursor-chat-scan` 落地。

## 一个 MCP 工具

`cursor_bridge`，action 枚举（docs/89：不新增长 6 个工具）。

| action | 作用 |
|--------|------|
| `init` | 绑定工作空间（`workspaceName`，或由 `projectPath` 推出其所属工作空间），可顺带设该工作空间的默认项目。**调用方本身跑在 CC-Panes 启动的会话里时不需要 init**——工作空间与项目从调用方 launchId 推断。 |
| `context` | 只读项目理解。print worker + `--mode ask` + `CCE_SEARCH_RESULT` 契约。**默认阻塞**到 worker 退出（`timeoutMs`，上限同 `wait_for_session`），读 PTY 缓冲，从标记处切出证据放进 `evidence.text`；`evidence.structured` 标记模型是否遵守格式；`complete=false` 为超时，回执里的 `ptySessionId` 可继续等。`wait=false` 只要回执。 |
| `do` | 有边界执行。`sessionMode=isolated\|create\|continue`。 |
| `status` | 登记簿 + 模型默认。给 `sessionId` 则只返回该会话。 |
| `model` | get/set `context` 与 `do` 两套默认。 |
| `session` | `close` / `forget` / `reconcile` / `abandon`。后两者必须 `confirm=true`。 |

公开 `dispatch_task` **不**暴露 `adapterOptions`。print / `--mode ask` 只从这条内部启动辅助注入。

## 作用域（workspace-first，docs/98）

每个 action 都接受可选的 `workspaceName` / `projectPath`。解析顺序：

| 要什么 | 顺序 |
|--------|------|
| 工作空间 | 显式 `workspaceName` → 显式 `projectPath` 的所属工作空间 → 调用方 launch 记录里的工作空间 → 上次 `init` 绑的工作空间（`~/.cc-panes/cursor-bridge/current-v1.json`） |
| 项目 | 显式 `projectPath` → 调用方自己的项目（须属于该工作空间） → 该工作空间登记簿里 `init` 设的默认项目 → 工作空间第一个项目 |

`context` / `do` 拿不到项目时报错；`status` / `model` / `session` 只需要工作空间。

## 会话契约

登记簿按工作空间分目录：`~/.cc-panes[-dev]/workspaces/<name>/cursor-bridge/{sessions,models,workspace}-v1.json`。
旧的全局目录 `~/.cc-panes[-dev]/cursor-bridge/` 只读保留：`resume_binding_service` 回写 chat id 时会连它一起搜，新会话不再写进去。

- `sessionId`（`cbrs-`）≠ `taskId`（`cbrt-`）≠ Cursor chat uuid
- `create` 后等 `cursor-chat-scan` 把 resume id 按 `launchId` 写回才变 `ready`
- `continue` 必须带精确 `sessionId`，不得降级 isolated
- 活 PTY 用 `submit_to_session`；已退出用 `--resume` + 新 prompt
- continue 不得换 workspace、不得取消 `readOnly`、不得扩大 `allowedPaths`
- 同一 `requestId` 重放返回已有 task
- 未知 `schemaVersion` 拒绝且不覆盖文件
- 不存 prompt / 回复 / token

`readOnly` / `allowedPaths` 是 prompt 边界，外加 CLI `--mode ask`。不是 OS 沙箱。主 agent 必须自己核 diff。

`context` 用的是 Cursor **CLI** 的代码理解，不是 IDE 索引。不要把它叫成参考项目的 CCE 商标。

## 单实例

登记簿是文件级读-改-写。`CursorBridgeHub`（`cc-panes-core/src/services/cursor_bridge_hub.rs`）在 `lib.rs` 里只建一次并 `manage`，按工作空间名缓存 `CursorBridgeService` 实例；orchestrator 与 `resume_binding_service`（把 `cursor-chat-scan` 扫到的 chat id 写回会话）都经它取实例——各开一个实例就是各持一把锁，会互相覆盖。`bind_resume_chat_id` 会遍历磁盘上所有工作空间的登记簿（含旧全局目录）找持有该 `launchId` 的会话。

## 取消

`sessionAction=close` 只切断 CC-Panes 连续性，不杀进程。杀进程走 `kill_session`。没有 Agent DOM，不猜点 Stop。

## 参考对照

| 参考项目 | CC-Panes |
|----------|----------|
| CDP :9223 + Agents DOM | `cursor-agent` PTY |
| 六个 MCP 工具 | 一个 `cursor_bridge` |
| `minimal` 藏窗口 | 不做 |
| 只维护最新 Cursor | 跟官方 CLI |
| 登记簿在 `%APPDATA%\cursor-bridge`（全局一份） | `{app_config_dir}/workspaces/<name>/cursor-bridge`（每工作空间一份） |
