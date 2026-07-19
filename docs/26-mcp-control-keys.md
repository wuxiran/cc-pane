# MCP 控制键送达修复：`\x` 不是合法 JSON 转义

> 状态：待实施 | 基线提交：`6a29b61`

## ⚠️ 并发警告

同一工作树内有其它 worker 在改代码。**本任务只许碰下列文件**：

- `src-tauri/src/services/orchestrator_service.rs`
- `cc-panes-core/src/services/terminal_service.rs`（仅新增测试）
- `src-tauri/resources/claude-bundle/default-skills/launch-task.md`

**不要碰**：`web/components/providers/`、`web/components/resources/`、
`web/stores/usePanesStore.ts`、`web/hooks/useOrchestratorListener.ts`、
`web/components/panes/`、`src-tauri/src/commands/clipboard_commands.rs`、
`src-tauri/src/commands/screenshot_commands.rs`。
**禁止任何 git 写操作**（add / commit / stash 都会波及别人的改动）。
测试若见上述目录相关失败，与本任务无关，忽略并注明。

`.claude/commands/ccbook/launch-task.md` **已由 leader 改好，不要再动**。

## 现象

AI 用 `write_to_session` 向另一个会话发 Esc（打断生成）或 Shift+Tab（切权限模式），
目标 Claude Code 毫无反应，且不报错。

## 根因

Rust 写入链路**完全字节透明**，没有任何转义/过滤/规范化：

- `orchestrator_service.rs:4250` → `backend.write(&sid, &txt)`（`:4257`），无变换
- `terminal_backend.rs:103`（in-process）/ `:234`（daemon，serde 无损往返）
- `terminal_service.rs:2661` `write` → `:2671` `write_unlocked`，`:2672` 就是 `data.as_bytes()`
- PTY writer `terminal_service.rs:882-891` `write_all` + `flush`，裸写
- 写入路径无 UTF-8 重校验（`String::from_utf8_lossy` 只出现在 `:846` 的日志函数里）

**真正的 0x1B 字节能到达 PTY。问题在参数边界**：

`\x03` 不是合法 JSON 转义。仓库内**没有任何 unescape 逻辑**
（已搜 `unescape` / `from_escaped` / `\x1b` / `\u001b`，只有 ANSI *解析* 辅助函数）。
`McpWriteToSessionParams.text`（`orchestrator_service.rs:1516`）是普通 `String`，
由 serde_json 反序列化。于是：

- 模型发 `{"text": "\x03"}` → serde_json 解析失败，工具调用报错
- 模型发 `{"text": "\\x03"}` → 到达的是 4 个字面字符 `\`、`x`、`0`、`3`，
  原样写进 PTY，目标 CLI 无反应 —— **发了不报错也没效果**，最难查的失败模式

而工具描述 `orchestrator_service.rs:1516` 明写 `Ctrl+C 用 "\x03"`，
skill 文档也重复了同样的错误指导。**是文档在教模型发一个 JSON 表达不了的东西。**

## 改动

### 1. 修工具描述（`orchestrator_service.rs:1516`）

改成明确要求 JSON `\u` 转义，并给出对照表：
`"\u001b"` = Esc，`"\u001b[Z"` = Shift+Tab，`"\u0003"` = Ctrl+C，
`"\u0004"` = Ctrl+D，回车用 `"\r"`（CR 非 LF）。
同时说明**控制键必须用 `write_to_session`，不能用 `submit_to_session`**。

### 2. 容错 unescape（MCP 边界，可选但推荐）

在 `orchestrator_service.rs:4250-4257` 内，对 `text` 做一次容错解码：
把字面量 `\xNN`、`\uNNNN`、`\e`、`\r`、`\n`、`\t` 解析成真字节，再交给 `backend.write`。

- **只在 MCP 边界做**，`TerminalService::write` 的裸字节契约保持不变
- 必须幂等安全：已经是真控制字节的输入不受影响
- 要考虑转义歧义——用户真想发字面反斜杠时用 `\\` 表示
- 加单元测试覆盖：`\x03` → 0x03、`\u001b[Z` → ESC+`[Z`、`\\x03` → 字面 `\x03`

REST 孪生实现 `orchestrator_service.rs:6557` `handle_write_to_session`（→ `:6584`）
走同一条 `backend.write`，改动需同时覆盖或共用同一个解码函数。

### 3. 修陈旧的 150ms 说明

`orchestrator_service.rs:1525` 和 `:4270` 都写着"等待 150ms"，
实际是 `min(200 + (len/512)*30, 5000)` ms（`terminal_service.rs:2733`）。改成实际值。

### 4. 补控制字节测试

`terminal_service.rs:3742` 附近现有测试（`submit_to_session_serializes_text_and_enter_per_session`、
`:3778`）全是 ASCII（`"alpha"`/`"beta"`），**控制字节零覆盖**。
新增：单独的 `\x1b`、`\x1b[Z` 经 `write` 后到达 recording writer 时未被修改。

### 5. 同步打包副本

`src-tauri/resources/claude-bundle/default-skills/launch-task.md:39,98,156`
有同样的 `"\x03"` 错误指导，按 leader 已改好的
`.claude/commands/ccbook/launch-task.md` 同步过来（**只同步，不要改后者**）。

## 已知但本次不做

`write` 抢每会话输入锁（`terminal_service.rs:2665`），该锁在 `submit_to_session` 的
"写文本 → 等待 → 发 CR"全过程持有（`:2725-2736`），等待最长 5000ms，
`TERMINAL_WRITE_ACK_TIMEOUT` 也是 5s（`:837`）。
**结果：目标会话正忙时发 Esc 会阻塞数秒甚至超时**——恰是最需要打断的时刻。
修它要改并发语义，风险高，**本次不动**，仅在汇报里确认现象是否复现。

## 验收

- `cargo check --workspace`
- `cargo clippy --workspace -- -D warnings`
- `cargo test --workspace`（至少本任务新增测试绿）
- 手动验证（若条件允许）：向一个运行中的 Claude Code 会话发 `{"text":"\u001b"}`，
  确认生成被打断
