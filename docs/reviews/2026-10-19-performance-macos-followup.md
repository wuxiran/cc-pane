# CC-Panes 性能与 macOS 后续修复

2026-10-19。本次继续在 `codex/perf-macos-audit` 修复上轮审阅留下的问题，并补齐交叉审阅发现的阻塞和诊断边界。代码提交为 `979a7503`，基于上轮交付 `1741f649`。

## 修复结果

| 问题 | 修复行为 |
| --- | --- |
| macOS 区域截图始终取消 | 使用系统 `screencapture` 原生选区；启用 macOS 全局快捷键，成功后保存 PNG 并复制路径。原始 PNG 直接移动，不再按固定 `(0,0)` 显示器截屏或重复缩放编码 |
| 首次授权与窗口恢复 | 只有用户触发截图时才预检/请求系统授权；拒绝或原生失败给出错误。取消保留剪贴板；捕获线程退出、失败或 panic 时释放防重入状态，恢复原先可见窗口，原先隐藏/最小化窗口保持原状 |
| 截图快捷键及存储边界 | Command 录为 `Super`，Control 单独录为 `Ctrl`；新键注册成功后才撤销旧键，冲突不使原键失效。文件名加入 UUID，裁剪边界用减法校验避免 u32 溢出 |
| WebKit XPC 漏采 | 责任 PID 与 resource coalition 双重核验，把 PPID=1 的 renderer、GPU、network 纳入应用诊断；不混入其他应用。秒/微秒级启动身份前后复核，CPU 基线拒绝 PID 复用 |
| Apple Silicon CPU 单位错误 | 原生 `proc_taskinfo` 的 Mach ticks 先作差，再按缓存的 timebase 换算纳秒；失败保持缺失。首次 CPU 为 null，读取失败省略该条，RSS 与 private memory 不混用 |
| 定时器诊断混淆与丢失 | 隐藏时停掉每秒心跳；超过30秒的未观测间隔单独记为 `samplingGapMs`，不声称它一定是睡眠。隐藏前收尾计时，保留已观测卡顿；IPC失败合并回待发送观测，避免丢掉故障现场 |
| 性能比较假改善 | 缺失 heap、CPU、RSS、队列和前端年龄保留 null；数值0参与比较；增加 renderer RSS。完全无可比数据不通过。跨旧/新采样口径保守合并 gap，避免把同一次长卡顿误算为“改善100%” |
| 目录统计阻塞界面 | 数据目录递归大小统计移到现有4槽后台池 |
| CLI 探测管道堵塞与超时失效 | Tokio 并发排空 stdout/stderr，每路上限512 KiB，8秒总期限同时覆盖父进程退出和管道 EOF；超时或取消回收探测父进程，共享4槽准入 |
| Git 捕获线程永久等待后代管道 | 用单个调用线程公平轮询双管道，取消每次命令额外的两个 reader 线程。Unix使用 nonblocking+poll，Windows使用PeekNamedPipe；无数据从1 ms退避到20 ms，有数据立即复位；总期限到达关闭读端并回收直接子进程，不杀整个后代进程组 |
| 首屏包体超标 | 设置内容、布局切换窗口和移动预览路由按需加载，复用既有懒加载重试机制；门禁预算没有放宽 |
| Finder 回归测试依赖交互 | 复用 audit 分支的删除适配器注入，让符号链接安全测试验证传入回收站适配器的实际叶节点；不再依赖 Finder 权限弹窗，也不改变生产回收站的 Put Back 语义 |

## 实测与验证

- 首屏入口 **883.7 → 876.0 KiB gzip**，通过880 KiB入口预算和1100 KiB首屏总量预算。xterm、Monaco、Mermaid继续独立加载。
- 本机安装版进程的只读探针识别出3个 CC-Panes WebKit 服务，排除另外9个；没有读取命令参数、页面或用户内容。
- Apple Silicon timebase为 **125/3**；单线程忙循环复测为 **94.975%**，符合单核100%的口径。不能把原始 ticks 当成纳秒。
- Rust全工作区：**2762 passed，0 failed，5 ignored，0 filtered**。以前过滤的 Finder 符号链接测试本次通过。
- 最终管道退避调整后，`utils::git_command` **16项**再次通过。
- 前端全量：**608个文件、5894项测试通过**。性能脚本17项、发布元数据9项通过。
- 严格 Clippy、格式检查、TypeScript、前端构建、macOS workspace构建全部通过。
- 四个sidecar已重建/同步到本分支bundle及debug运行目录，逐一SHA256一致；Web资源同步完成。
- 新增Windows管道模块使用同一个源文件和windows 0.62.2完成x86_64-pc-windows-gnu交叉编译；这不等于Windows原生执行验证。
- 临时Git树依次合并audit、deep-audit、chat-fork、agent-chat-timeline四个分支均无文本冲突。没有修改这些分支，组合版本的运行验证不在本次结果内。

## 验证范围

截图的成功、取消、拒绝授权、首次请求、文件内容、恢复守卫及异常路径通过隔离测试；没有在用户桌面自动点击系统权限提示或执行真实选区。因此实际权限交互、混合DPI显示器拖选仍需新版应用中的交互验收。

WebKit归属使用可选的系统私有SPI，已动态解析并按Apple XNU ABI检查大小。不可用或无法确认归属时保守省略该服务；通过Terminal启动的dev应用可能归责给Terminal而被省略。已验证的是本机安装版的三个服务。[Apple XNU进程信息结构](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h)、[Mach计时数据实现](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c)。

代码保留在 `/Users/wuxiran/workspace/rust/cc-pane-perf-macos`，未推送或替换运行中的安装版。前一轮的局部性能基准仍仅代表对应热点，未将本次修复称为整机或端到端同等提速。

本机证据目录：`/Users/wuxiran/Documents/ChatGPT/ccpane/perf-evidence/2026-10-19-followup/`。包含workspace/frontend完整日志、bundle预算、WebKit归属及CPU探针、Windows编译harness位置、sidecar哈希和合并检查结果。
