# 性能记录：卡顿与内存增长排障

正式版和开发版各自在自己的日志目录保存记录。桌面启动后自动运行，无需开启
DevTools。在 **设置 → 关于 → 性能记录** 可打开目录或“标记当前卡顿”。

Windows 正式版默认路径：
`%LOCALAPPDATA%\com.ccpanes.app\logs\performance\`

## 保存规则

- 后端独立线程每 15 秒采样；页面不响应时，进程资源和旧页面采样的年龄仍会写入。
- `performance.jsonl` 为当前文件；`.1` 至 `.7` 为旧文件。单文件最多 8 MiB，
  合计最多 64 MiB，自动覆盖最旧文件。实际覆盖多少天取决于终端数量和事件量。
- 每次启动生成 bootId；记录包含版本、平台、PID、Unix 毫秒时间戳。
  比较内存趋势时必须按 bootId + PID 分组，不能把重启后的下降当成自动回收。
- 每行一个 JSON 对象。进程命令行、终端正文、键盘输入、提示词、凭据不进入记录。
- 事件队列最多 128 条；写入失败显示在设置中，队列溢出会累计 droppedEvents。
  正常退出写入 stop；强制结束或崩溃可能没有 stop，末行也可能不完整。

## 字段与判读

| 字段 | 含义 |
| --- | --- |
| processes | 主程序、当前窗口族的 WebView、daemon 的数值资源。最多 32 个进程 |
| privateBytes / residentBytes | Windows 私有内存 / 驻留工作集；其他平台 privateBytes 可能为 null |
| cpuPercent | 单核为 100%，多核进程可以超过 100%；首次采样可能为 null |
| frontendAgeMs | 上一次页面报告距今多久。显著增长表示页面没有按时上报，需要结合可见性判断 |
| failedTerminalSources | 当前采样失败的终端视图数；一个视图失败不会阻止其他视图上报 |
| heapUsedBytes | 主窗口 JS 堆近似占用；浏览器不支持时为 null，不等同整个 renderer 内存 |
| timerLagMs / longTaskMaxMs | 定时器延迟 / 主线程长任务；支持情况见 longTaskSupported |
| queuedChars / inFlightChars / hiddenChars | 等待 xterm、已交给 xterm 未完成、隐藏缓冲的 UTF-16 字符数，不能当 UTF-8 字节数 |
| receivedChars / writeCalls | 本终端视图生命周期累计写入字符数和调用数 |
| resyncCount / resyncChars | 累计全量重放次数和字符量。前端最多保留 128 个会话的计数，淘汰后归零 |
| oldestWaitMs / callbackMaxMs | 当前队列最老等待时间 / 视图生命周期内最长写入完成等待时间 |
| renderer / contextLosses | 实际 DOM/WebGL 渲染器与上下文丢失次数 |
| bridge / event | 连接模式、重试计数，以及 polling、websocket、resync、manualMarker 时间点 |
| sampleDurationMs | 后端采样自身耗时，便于判断记录器开销 |

页面明细最多 32 个视图，优先保留积压最大的视图；terminalCount 是当前有 xterm
实例、能采样的视图总数，不包括已经休眠销毁的实例。
同一 PTY 的镜像视图会有重复 sessionId。页面指标只覆盖主窗口，原生进程指标
同时覆盖它的 WebView 子进程。日志不包含堆对象，因此只能定位增长发生在哪个
进程、是否伴随积压/重放；具体对象泄漏仍需后续堆快照。

隐藏视图的 resyncActive=true 也可能表示等待可见后再恢复；应结合 visible 和
resyncCount 的增量判断，不应单凭这个标志认定后台一直在重放。

## 下次出现问题

1. 点击“标记当前卡顿”，或记下本地时间；卡死时不要为了打开设置反复操作。
2. 保留 performance 目录所有 JSONL 文件，并一起保留同级应用日志。
   如果整个程序闪退，同时保留 `%USERPROFILE%\.cc-panes\crash.log`（开发版为
   `.cc-panes-dev`），按发生时间核对 Windows 应用程序事件；panic 与资源耗尽
   需要分别取证。已知案例见 [Grok 全屏恢复与对话闪退](../bugs/grok-fullscreen-recovery-and-transcript-crash.md)。
3. 运行摘要工具，快速查看各进程内存首值/末值/峰值、CPU、积压和事件计数：

```powershell
node scripts/summarize-performance.mjs --dir "$env:LOCALAPPDATA\com.ccpanes.app\logs\performance"
```

工具逐行读取，容忍崩溃留下的不完整行，不把整个日志载入内存。分析时先核对
bootId、版本和时间，再区分：进程私有内存增长、JS 堆增长、终端写队列增长，
或连接退化后重放量增长。短时峰值和重启后的下降都不足以单独证明内存泄漏。

## 本机交付验证（2026-09-07）

- Windows TypeScript 检查、46 项相关 Vitest、4 项记录器 Rust 测试通过。
  资源服务测试 10 项通过，原有 1 项现场枚举预算测试保持 ignored。
- Clippy `-p cc-panes --lib -- -D warnings`、前端构建与 Tauri release 构建通过。
  前端构建仍有 CSS 和分块警告；本机新页面已正常启动并持续上报。
- 摘要工具 Node 测试通过；已对实际日志运行摘要，无损坏行。
- 已更新 Windows 正式主程序，PID 176624；daemon PID 158588 保持运行，
  更新前 14 个会话全部保留。程序文件 SHA-256：
  `00F20913BD7179BE3BB4D064247900344C2BC649D880EBDB36B9E28C7D3C8DB1`。
- 实际记录包含原生进程资源、页面 JS 堆、10 个终端视图和连接事件；
  采样失败数为 0，最近后端采样耗时 51/56/55 ms。未开启远程调试端口。
- 备份程序：
  `C:\Users\wuxiran\AppData\Local\cc-panes\backups\cc-panes-before-diagnostics-20260907-040237.exe`。
