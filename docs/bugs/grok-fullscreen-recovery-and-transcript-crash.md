# Grok 全屏恢复异常与打开对话闪退（2026-09-07）

## 现场证据

- PTY `10621b33-9032-43e9-835f-21f4fc3c54ac` 的后台恢复快照为
  `bufferMode=alternate`、`checkpoint=null`，保留约 8 MiB 原始输出。
  输出中已没有 `47/1047/1049` 备用屏切换序列。前端 reset 后仅重放这些输出，
  会保持 normal buffer，产生全屏程序不应有的外层历史滚动和错乱画面。
- Windows 正式版 `~/.cc-panes/crash.log` 在本地时间 16:16:50.203 记录
  `grok.rs:445:22: assertion failed: self.is_char_boundary(new_len)`；随后出现
  `panic in a function that cannot unwind`。Windows 应用事件同步记录
  `cc-panes.exe`、异常 `0xc0000409`。因此这次打开对话闪退有明确的原生 panic
  原因，不能仅凭先前的内存增长现象归因于 OOM。
- 工具结果预览使用 `String::truncate(4000)` 按字节截断，切进中文或表情时 panic。
  同步 Tauri command 在原生 IPC 回调中执行解析，panic 最终导致进程退出。

记录只保留模式、长度、时间、错误位置等元数据，不复制会话正文或凭据。

## 修复

- 无 checkpoint 的 attach、desync、休眠恢复共用屏幕模式恢复逻辑。
  快照的模式是输出末尾状态；有切换序列时从第一个切换推断起始状态，没有时
  使用后台模式。补入的序列经过既有 raw renderer，继续尊重 CLI 的 strip 设置。
  有序列化 checkpoint 时以照片状态为准，不用后台原始模式覆盖前端渲染选择。
  扫描主动让出主线程，并在视图销毁后取消。
- 工具输出仍按原有字节上限限制，但截断位置回退到完整 UTF-8 字符边界。
- 对话文件读取与 JSON 解析改为异步 command + blocking worker。任务失败返回
  既有 `parseError` 结果结构，不把 panic 内容回传到界面，也不经过原生 IPC 栈展开。

## 回归范围

- 使用真实 xterm 解析器覆盖 attach/resync、进入序列被淘汰、空备用屏、三种
  备用屏退出、保留 shell 历史、显式 strip、checkpoint 与后台模式不同。
- 覆盖扫描取消、ASCII/中文/表情在 4000 字节附近截断、错误工具结果、完整边界，
  以及 worker panic 转换为前端可显示的错误结果。
- 修复前，新测试复现 10 项全屏恢复失败；Rust 中文截断用例复现同一 panic。

## Windows 交付与验收

- 修复后 160 项相关 Vitest（7 个文件）、12 项对话解析 Rust 测试、2 项原生
  command worker 测试通过。TypeScript、定向 rustfmt、Clippy
  `-p cc-panes --lib -- -D warnings`、前端构建、Tauri release 构建退出码均为 0。
  前端构建仍有既有 CSS/分块警告，jsdom 不实现 canvas；真实渲染在 Windows 验证。
- 已更新 Windows 正式主程序，SHA-256：
  `29E7EBB0217C381C5574136A83D871667D0401575199394C829AD17A54EDB6D5`。
  原程序备份为 `%LOCALAPPDATA%\cc-panes\backups\cc-panes-before-grok-fix-20260907-165152.exe`。
- Windows WebView2 现场可见的指定 Grok 会话为 `alternate`、61 行 × 120 列，
  `baseY=viewportY=0`；执行仅改变终端视口的 `scrollLines(-100)` 后仍为 0。
  没有向 Grok 任务发送测试输入。
- 实际点击该会话的“对话”按钮，页面可见且成功显示最近 200 条消息；返回终端
  正常。`crash.log` 仍为 9559 字节、修改时间仍为 16:16:50，没有新增 panic。
- 更新前 15 个 PTY 全部保留；daemon PID 158588、指定 Grok PID 186076 未变。
  原始崩溃日志已备份到性能记录目录的 `crash-before-grok-fix-20260907.log`。
- 临时 WebView2 调试入口已关闭（9225 端口连接失败）；最终主程序 PID 171184，
  同一修复程序已重新启动，性能记录已产生新的 start 和连续 sample。
- 验收范围为上述故障与当前 Windows 程序；未运行整个 workspace 测试或安装包验证，
  短期检查也不能代替长期内存趋势观察。
