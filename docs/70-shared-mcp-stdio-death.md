# 70 — shared MCP 启动即自杀：stdio 服务器在双层套壳下 stdin 立即 EOF

> **状态：已修（2026-08-25）。** `McpProxy` 启动时保留 piped stdin，避免 stdio server 因 EOF 退出；`NativeHttp` 仍使用 null stdin。
> 相关：[docs/57](./57-ccpanes-ctl-and-mcp-orphan.md)（自研 stdio↔HTTP 代理就是为这类问题造的）。

## 用户看到的现象

「让 AI 打开 chromedev，它打开的是我们自己的窗口，而不是真的 Chrome DevTools。」

看起来像 AI 选错了工具，实际上**那套工具根本不存在**——`chrome-devtools` shared MCP
已经死了，AI 只剩 CC-Panes 自己的 `browser_navigate` / `open_browser_tab`，于是打开了
内置浏览器窗格。

这是「静默降级」的又一个实例：工具全部正常返回，只是返回的不是你要的东西
（同类见 CLAUDE.md 的 agent 实例串台那条）。

## 三层问题

### 1. 进程启动即自杀（根因，已复现）

`chrome-devtools-mcp` 自己的日志里每一次都是同一个形状：

```
Starting Chrome DevTools MCP Server v1.6.0
Chrome DevTools MCP Server connected
Shutting down (stdin end)      ← 1ms 后
```

它是 **stdio MCP 服务器，靠 stdin 存活**。而
`cc-panes-core/src/services/shared_mcp_service.rs` 的 `spawn_server_process`
对**所有** `bridge_mode` 一律：

```rust
.stdout(Stdio::null())
.stderr(Stdio::null())
.stdin(Stdio::null());     // ← stdio 服务器在这里必死
```

实际启动链是双层套壳（`build_mcp_proxy_invocation` + Windows 的 `cmd /c` 前缀）：

```
cmd /c npx -y mcp-proxy --port 3106 -- cmd /c npx -y chrome-devtools-mcp@latest …
```

于是三次重启全部失败，触发上限后彻底停摆：

```
[04:46:51] 'chrome-devtools-windows' exited with status: ExitStatus(1)
[04:46:51] ERROR exceeded max restarts (3), auto-restart stopped until manual restart
```

**对照实验结论**：内层 `cmd /c` **不能去掉**——Windows 上 `npx` 是 .cmd 脚本，
直接 spawn 根本起不来（去掉后连日志都没有）。所以修复必须落在 stdin 传递上，
不能靠简化命令行绕开。

### 2. 自研代理没被用上（架构不一致）

`cc-panes-ctl/src/proxy.rs` 是「可恢复 stdio↔HTTP MCP 代理」，docs/57 明写它是
**根治 MCP 孤儿**用的。但 shared MCP 走的是第三方 `npx -y mcp-proxy`——每次启动都要
过一次 npx 解析，还多套一层 `cmd`。修这条时应先回答：为什么不复用自己的 proxy？

### 3. 就算修好启动，也连不上 Chrome

配置是 `--browserUrl=http://127.0.0.1:9222`，需要一个已开远程调试的 Chrome。
实测 **9222 无人监听**（curl 无响应，netstat 只有 TIME_WAIT）。

所以「进程活着」只是必要条件。还得回答：**谁负责启动带
`--remote-debugging-port=9222` 的 Chrome**？是让用户自己开、我们代启、还是去掉
`--browserUrl` 让 MCP 自己拉一个浏览器实例。这是产品决策，不是纯技术修复。

## 修复要求

三块都要覆盖，缺一条都会让用户觉得「还是不好使」：

1. **stdin 传递**：`spawn_server_process` 按 `bridge_mode` / 服务器类型区分对待，
   stdio 类不能给 `Stdio::null()`。或改用 `cc-panes-ctl` 自研 proxy（连带解决第 2 条）。
   注意别顺手把 `stdout/stderr` 也放开——那会把 MCP 的日志灌进 app 日志。
2. **Chrome 9222 的责任归属**：先定产品决策再写代码。
3. **可见告警**：shared MCP 达到 `maxRestarts` 时必须让用户看见。
   `OrchestratorAlertBanner.tsx` 已有现成形态（AppShell 顶部条、status token 配色、非模态），
   照抄即可，别新造设计语言。没有这条，下次任何 MCP 静默死掉仍然只能靠用户抱怨发现
   ——这正是本次的发现路径。

## 验证

必须在 **Windows 宿主**验（stdin/cmd 行为是平台特有的，WSL 全绿不算数）：

1. 重启 app，`shared-mcp` 日志里 `chrome-devtools-windows` 不再反复 `exited with status: 1`
2. `curl http://127.0.0.1:3106/sse` 不是 502
3. `C:/Users/.../Temp/chrome-devtools-mcp-ccpanes.log` 不再出现 `Shutting down (stdin end)`
4. 开一个带 `--remote-debugging-port=9222` 的 Chrome，AI 调 chrome-devtools 工具能真正操作它
5. 故意配一个必然失败的 shared MCP，确认达到重启上限后 UI 有可见告警

## 本次修复（2026-08-25）

`cc-panes-core/src/services/shared_mcp_service.rs` 现在按桥接模式配置 stdin：

- `McpProxy` 使用 `Stdio::piped()`，并把 `ChildStdin` 移入 `ServerRuntime`，在 server
  生命周期内保持句柄存活，因此不会因为 app 提前关闭 stdin 而收到 EOF。
- `NativeHttp` 继续使用 `Stdio::null()`；它不依赖 stdio 输入，避免无意义地持有句柄。
- Windows 的外层和内层 `cmd /c` 命令构造保持不变，修复只涉及 stdin 传递和句柄生命周期。

这次修复覆盖的是 shared MCP 的 stdin 自杀根因。Chrome 9222 仍是外部运行前提：Windows
宿主需要自行启动带 `--remote-debugging-port=9222` 的 Chrome；端口和真实工具调用仍需按
上面的 Windows 验证步骤验收。

## 临时绕过

在修复前：手动重启该 shared MCP（`restart_shared_mcp_server`），并自己启动一个带
`--remote-debugging-port=9222` 的 Chrome。注意重启只是重置计数，stdin 问题仍在，
它大概率会再次在 3 次内耗尽重启次数。
