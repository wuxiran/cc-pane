# 终端断流后反复重放导致卡顿（2026-09-07）

## 现场证据

- Windows 正式实例 0.12.12，11 个存活终端。故障采样时 WebView2 renderer
  工作集约 10.4 GiB，CPU 约 542%（单核 100%）；后续私有内存超过 12 GiB。
- 日志记录多个会话因 Windows socket 10060 退回轮询。
- 两个持续输出会话的原始缓冲达到约 8 MiB，且没有 checkpoint。
  对其中一个连续做三次快照比较，三次都无法以前一次完整快照作为前缀。
- 原实现每秒读取快照，前缀失配触发 desync，前端随即 reset 并重放整个恢复窗口。
  缓冲正常淘汰旧字节也被当作丢流，并且进入轮询后不会恢复 WebSocket。
- 当前视频壁纸为 3840×2160、终端不透明度 20%。DOM 检查确认终端没有 WebGL canvas。
  本次修复保持原外观设置。

## 修复

- 优先读取现有 recovery-snapshot 接口，以 checkpointEpoch、endSeq 和原始
  UTF-8 字节长度确定增量，正常滚动和 checkpoint 重定位不再触发全量重放。
- 真正的字节缺口、epoch 改变或不合法的 UTF-8 切分仍请求画面恢复。
- 轮询期间每隔 5 秒启动一轮有超时、次数和全局并发上限的后台重连。
- 重连先订阅，再读取快照补齐断开期间的输出；丢弃已被快照覆盖的队列帧，
  部分重叠只转发新增后缀。
- 没收到 exit/killed 就关闭的 WebSocket 进入恢复流程，不直接宣告 PTY 退出。
- 不支持 recovery-snapshot 的旧 daemon 保留旧快照兼容路径。

## 验证与安装

- Windows `cargo test -p cc-panes --lib terminal_daemon`：47 passed，退出码 0。
  覆盖滚动窗口、真实缺口、重复帧、中文/emoji 字节边界、epoch、定时重连、
  握手超时和并发限制，以及已有退出事件回归。
- Windows `cargo clippy -p cc-panes --lib -- -D warnings`：退出码 0。
- 修改文件 rustfmt 检查、git diff --check：退出码 0。
- Windows Tauri release 编译：退出码 0；复用现有 dist，不重新构建前端和 sidecar。
- 当前安装目录仅替换主程序，保留 0.12.12 版本号作为本机热修复。
  安装文件 SHA-256：
  `A320ECAC9B53AFE4EB4BB54B95E73FC1C8FF230F966E72C5B47C7B527C22BFBE`。
- 更新后主程序 PID 164832；daemon 仍是 PID 158588；11 个原会话全部存活。
- 补丁启动后两个 8 秒采样窗口：renderer 私有内存 575/636 MiB，工作集
  614/674 MiB，CPU 46.6%/53.8%（单核 100%）；主程序保持响应。
  主程序到 daemon 有 10 条已建立连接；仅作现场短时验证，不代表长期稳定性测试。
- 临时诊断启动参数仅用于排障；安装补丁后按正常参数启动。
- 真实网络断流注入未执行；自动重连由虚拟时钟回归验证。
  现场内存高占用未取堆快照，不能据此直接定性为内存泄漏。

## 本机回退

主程序备份：
`C:\Users\wuxiran\AppData\Local\cc-panes\backups\cc-panes-before-terminal-perf-20260907-031328.exe`。

需要回退时，退出主程序后将该备份复制回同目录上层的 `cc-panes.exe`，再启动。
daemon 和存活终端无需停止。旧文件 SHA-256：
`062A9444FC750B08FBF711E2C5038492453951708FC28AA38B836F0322F268EC`。

## 第二次卡顿：大快照同步处理（2026-09-07 04:20）

性能记录显示当时 11 条终端连接全为 WebSocket、polling=0，但一个前台会话
重放约 8.3M 字符后，主线程长任务达到 719 ms，JS 堆从约 146 MiB 升至 248 MiB。
这轮采样没有持续写队列积压，瓶颈集中在一次大段处理。

- xterm 的 12 ms 写入预算在每个输入块处理完成后检查，不能打断单个 8 MiB 块。
  前面的透明背景处理也同步扫描整段，因此仅调用异步 write 不足以让出界面线程。
- 快照重放和休眠唤醒改为通常约 32 Ki 字符分块，在变换之前切分；保留 UTF-16
  代理对和 CSI 边界，逐块等待写入完成，每轮累计 8 ms 后让出主线程。
- 隐藏视图的 desync 保持恢复闸门，延迟到可见时处理。解绑后取消旧重放，
  防止继续写入已经替换的终端。
- daemon 已宣布 desync 后清除旧连续性锚点，避免第一块恢复输出又触发重复重放。
- Tauri 的大快照读取、JSON 解码和历史观察恢复移入 blocking worker，避免阻塞
  桌面 IPC 线程；响应形状和旧 daemon 回落语义保持一致。

Windows Node 离线基准（8,388,668 字符，两轮背景色处理；不等同完整 WebView2 渲染）：

| 方式 | 总耗时 | 最长同步处理 | 最大定时器延迟 |
| --- | --- | --- | --- |
| 整段 | 631 ms | 631 ms | 637 ms |
| 分块 | 655 ms | 4 ms | 15 ms |

两种输出 SHA-256 相同。103 项相关前端测试、48 项 daemon 相关 Rust 测试和
Clippy 通过；现场改善仍以更新后的 Windows 性能记录为准。

本机安装与验证：

- 另有 8 项终端命令测试通过；Windows 正式构建通过。
- 已安装文件 SHA-256：
  `0DA515C722E3F9840E03FF781CFDBF34115027F67410C697B033C09CC1287CDA`。
- 重启后默认首页不能作为性能验收依据。切回终端后，确认原 11 个视图均复用
  原 sessionId；多份约 8.3M 字符历史分为约 254 次写入，最长写入回调等待约 132 ms。
- 再在 4 个可见终端下，对当前 cc-book 会话发起一次受控 desync（日志中带
  manualMarker）。该次恢复约 8,314,241 字符，4 秒观察期间无 >=50 ms 长任务，
  最大 10 ms 定时器延迟约 32 ms；恢复后 queued/in-flight 字符数为 0。
- 临时本地调试端口在验证后关闭；诊断记录保持开启。以上是定向短时验证，
  不代表其它卡顿来源或长期内存问题已全部排除。
- 本轮主程序备份：
  `C:\Users\wuxiran\AppData\Local\cc-panes\backups\cc-panes-before-chunked-replay-20260907-050034.exe`。
