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
| `init` | 绑定已注册项目的绝对路径。后续可省略 `projectPath`。 |
| `context` | 只读项目理解。print worker + `--mode ask` + `CCE_SEARCH_RESULT` 契约。**默认阻塞**到 worker 退出（`timeoutMs`，上限同 `wait_for_session`），读 PTY 缓冲，从标记处切出证据放进 `evidence.text`；`evidence.structured` 标记模型是否遵守格式；`complete=false` 为超时，回执里的 `ptySessionId` 可继续等。`wait=false` 只要回执。 |
| `do` | 有边界执行。`sessionMode=isolated\|create\|continue`。 |
| `status` | 登记簿 + 模型默认。给 `sessionId` 则只返回该会话。 |
| `model` | get/set `context` 与 `do` 两套默认。 |
| `session` | `close` / `forget` / `reconcile` / `abandon`。后两者必须 `confirm=true`。 |

公开 `dispatch_task` **不**暴露 `adapterOptions`。print / `--mode ask` 只从这条内部启动辅助注入。

## 会话契约

登记簿：`~/.cc-panes[-dev]/cursor-bridge/sessions-v1.json`。

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

登记簿是文件级读-改-写。`CursorBridgeService` 在 `lib.rs` 里只 `open` 一次并 `manage`，orchestrator 与 `resume_binding_service`（把 `cursor-chat-scan` 扫到的 chat id 写回会话）都取这同一份——各开一个实例就是各持一把锁，会互相覆盖。

## 取消

`sessionAction=close` 只切断 CC-Panes 连续性，不杀进程。杀进程走 `kill_session`。没有 Agent DOM，不猜点 Stop。

## 参考对照

| 参考项目 | CC-Panes |
|----------|----------|
| CDP :9223 + Agents DOM | `cursor-agent` PTY |
| 六个 MCP 工具 | 一个 `cursor_bridge` |
| `minimal` 藏窗口 | 不做 |
| 只维护最新 Cursor | 跟官方 CLI |
| 登记簿在 `%APPDATA%\cursor-bridge` | `{app_config_dir}/cursor-bridge` |
