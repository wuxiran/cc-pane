# daemon 请求打爆本机端口 → WebSocket 掉线 → 终端"停住"

> 2026-10-10 实机排障（0.12.20 安装版，31 个会话在线）。症状：终端输出偶发停止更新，
> 界面其余部分仍可操作，右键 → 刷新后恢复。

## 现象链

1. app → daemon 的每个 REST 请求新建一条 TCP 连接并带 `Connection: close`
   （`cc-panes-core/src/services/daemon_client.rs`）。
2. 请求源：
   - 终端 watchdog D（`useTerminalWriteWatchdog.ts`）：每个**已挂载**的终端视图每 2s
     调一次 `get_all_terminal_status`。`lastOutputReceivedAtRef` 初值 0，休眠/后台视图永远
     判定为"饿死"，持续轮询。31 个会话 ≈ 15.5 次/秒。
   - 每条 WebSocket 每 5s 一次 `get_session_status`（`WEBSOCKET_STATUS_INTERVAL`）≈ 6 次/秒。
   - 实测合计 **≈ 29 次/秒**（20s 内新增 584 条到 daemon 端口的连接）。
3. 本机 2400+ 个 TIME_WAIT 全部挂在 daemon 监听端口上，随后 **WSAENOBUFS (10055)**：
   `terminal websocket interrupted ... 系统缓冲区空间不足或队列已满`，10 月 3–6 日每天 13–31 次。
4. WebSocket 断 → 回退轮询 → 重连补差失败 → daemon 声明 desync → **全量重放**
   （性能记录 `recoveryReason: "daemon-desync"`，单次 2.4 MB / 3.2 s）。重放期间主线程被占满，
   画面停住；恢复链路没走完就一直停着。
5. 旁证：渲染进程 CPU 日均 5% → 50–77%（峰值 131%），私有内存 619 MB → 953 MB；
   daemon 日志每天数次 `[output-flow] park-enter`（前端迟迟不 ack，在途最高 5 MB）。

## 为什么之前看不见

- 发布版里 watchdog / 渲染器 / resync 事件全部不落盘（`useTerminalDebugLog.ts` 只在 DEV 开）。
- `RenderProcessUnresponsive` 只记日志不处理（`webview_reliability.rs`）。
- 唯一的线索是后台性能采样（`%LOCALAPPDATA%\com.ccpanes.app\logs\performance\`）
  和 `cc-panes.log` 里的 10055。

## 修复

| 项 | 位置 | 内容 |
|---|---|---|
| 连接复用 | `daemon_client.rs` | HTTP/1.1 keep-alive 连接池（空闲上限 4），按 Content-Length / chunked 定界读响应，1xx/204/304 按无 body 处理（hyper 的 204 不带任何定界头且保持连接，按「读到关闭」会卡到读超时）；池中连接被对端回收时换新连接重发一次 |
| watchdog D 降频 | `useTerminalWriteWatchdog.ts` | 只对可见视图做饿死对照 |
| 共享状态查询 | `terminal/daemonStatusCache.ts` | `get_all_terminal_status` 页面级合并 + 1.5s 缓存 |
| 发布版诊断 | `useTerminalDebugLog.ts` | `watchdog.* / renderer.* / webgl.* / resync.* / recovery.*` 事件限频后写入 `cc-panes.log`（`[terminal-diag]`） |
| 无响应自愈 | `webview_reliability.rs` | `RenderProcessUnresponsive` → reload，120s 冷却 |
| 日志降噪 | `usage_stats_service.rs` | 同一文件解析失败只 WARN 一次，之后 debug |

## 排障速查

```powershell
# daemon 端口上的 TIME_WAIT 数（修复后应接近 0）
$p = (Get-NetTCPConnection -OwningProcess (Get-Process cc-panes-daemon).Id -State Listen).LocalPort
(Get-NetTCPConnection -State TimeWait | Where-Object LocalPort -eq $p).Count
# 10055 / 掉线
Select-String -Path "$env:LOCALAPPDATA\com.ccpanes.app\logs\cc-panes.log" -Pattern '10055|websocket interrupted'
# 发布版终端诊断事件
Select-String -Path "$env:LOCALAPPDATA\com.ccpanes.app\logs\cc-panes.log" -Pattern 'terminal-diag'
```
