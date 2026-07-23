# 44 — `/clear` 导致会话被误判退出(Process exited with code -1)

> 状态:已定位待修。本文是修复规格(Worker E 执行依据),调查由只读 agent 完成。

## 现象

CC-Panes 内置终端的 Claude Code 会话里执行 `/clear`,约 0-500ms 内终端显示黄色
`Process exited with code -1`,标签页停止更新,会话"死亡"——但 PTY 子进程实际仍存活。

## 触发链(已核实,文件:行号)

1. `/clear` 触发 Claude Code 的 **SessionEnd 生命周期 hook(reason="clear")**。CC-Panes 注入的 hook 注册:`cc-cli-adapters/src/claude.rs:106-113`(`state-session-end`,matcher 空 = 无条件)。
2. hook 进程**不解析 stdin 的 reason,无条件上报 "session-end"**,且走双通道:
   - HTTP:`cc-panes-cli-hook/src/main.rs:73` → `events/dispatch.rs:68-101`(reason 只作不透明 payload 透传);
   - OSC in-band:`main.rs:106` → `dispatch.rs:63` 写 `ESC]777;notify;CCPanes;claude;session-end ESC\`。
3. 状态机 `session-end` → `Exited`:`session_state_machine.rs:468`、`:249-252`;OSC 通道等价(`osc_state_detect.rs:175` → `terminal_service.rs:3303`)。
4. listener 把 Exited **写回 session.status**(进程存活也写):`orchestrator_service.rs:806` → `terminal_service.rs:3154-3165 apply_hook_status`。
5. daemon 桥 500ms 轮询:`build_session_status_info`(`terminal_service.rs:1122`)原样透传 status 不校验进程;`is_terminal()`(`:356`)对 Exited 为真 → `terminal_daemon_event_bridge.rs:324-325` `emit_terminal_exit_once(id, exit_code.unwrap_or(-1))` → **-1 合成码**,`PollStatus::Done` 桥接循环退出、`terminal_exit_emitted` 置位——后续 SessionStart(source=clear) 无法复活。
6. 前端渲染:`web/components/panes/TerminalView.tsx:807`。

排除项(勿再查):CSI 清屏/RIS 不进状态机;alt-buffer stripper 只认 1049/1047/47;OSC 133;D 已特意映射为 Idle;/clear 不重启 PTY;0.10.19-0.10.21 未改此链路(存量 bug)。

## 修复要求

1. **主修 · hook 按 reason 过滤**:`cc-panes-cli-hook` 的 SessionEnd 处理解析 stdin JSON 的 `reason`;`reason ∈ {clear, prompt_input_exit}` 时**跳过** HTTP `report_with_payload("session-end")` 与 OSC `emit_terminal_sequence("session-end")` 两条通道(可改报非终止事件或什么都不发;倾向不发,/clear 后紧跟的 SessionStart 会自然刷新状态)。`logout`/`other` 维持现状。reason 缺失/解析失败按现状上报(fail-open 保持旧行为)。
2. **纵深 · hook 派生的 Exited 不等于进程退出**:在 `apply_hook_status` 写回或桥接 `is_terminal` 分支消费处,增加进程存活校验——PTY 进程仍存活时不得发 `terminal-exit`(实现位置二选一,优先桥接消费侧:要求真实退出证据——daemon exit WS 消息或会话从 map 移除——才 emit;`docs/38-mcp-kill-tab-close.md` 的 kill 语义不得回归)。
3. 测试:hook 侧 reason 过滤单测(clear/prompt_input_exit 不上报、logout/缺失上报);状态机/桥接侧"hook Exited + 进程存活 → 不发 exit"用例;`docs/38` 相关既有测试不得回归。
4. 同类排查:Codex/其他 CLI 的等价 SessionEnd hook(若有)按同一语义处理。

## 验证

- 单测 + `cargo test -p cc-panes-core` 相关模块、cli-hook crate 测试。
- 手工:daemon 模式启动 Claude 会话 → `/clear` → 会话继续可用,无 -1;`/exit` 或杀进程 → 正常收到真实退出。
