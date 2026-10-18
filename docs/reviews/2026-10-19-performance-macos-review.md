# CC-Panes 性能优化与 macOS 审阅

2026-10-19。基于 `05b90744`，实现位于 `codex/perf-macos-audit`。本次优化覆盖终端输出、后台统计扫描、IPC 文件操作、托盘刷新、macOS 进程采样和 Unix 优先级策略。已有终端读写线程继续保持字节顺序，新增后台执行有并发上限。

## 已落实的优化

| 路径 | 原有成本或错误 | 修改后的行为 |
| --- | --- | --- |
| PTY 输出 | Unix 每个块复制原始字节，发送批处理时再克隆字符串；状态与强提示重复解析 ANSI；所有本地终端都执行 SSH 提示文本清洗 | 借用原始字节、移动输出字符串；一次解析同时返回状态与通知强度；只有 SSH 认证路径清洗提示文本 |
| 用量统计 | 定时任务在 Tokio worker 中同步遍历日志、解析 JSONL、访问 SQLite | 初始化版本检查和扫描进入 blocking pool；保留单扫描门禁和异常时的 guard 释放 |
| 托盘 | 节流窗口的第一次刷新在回调线程直接请求 daemon 并读数据库；慢刷新可能与后续刷新重叠 | 首次刷新也在后台执行；每个控制器同时只有一个刷新 worker，300 ms 合并事件，慢刷新期间最多积累一次待更新标记 |
| Tauri 命令 | 历史状态读取、resume 查找、索引查询、rollout 存在性检查、壁纸操作、代理及 CLI 探测使用同步 command | 11 个命令改为 async 加 blocking pool；共同上限 4 个任务；请求取消后，实际 I/O 结束前仍持有名额 |
| 整机状态 | 进程扫描与轻量 CPU、内存查询共享同一个 `System` 锁 | 独立采样实例和锁；资源面板枚举不再挡住状态栏查询；退出进程的详细缓存继续清理 |
| macOS 拓扑 | 用 sysinfo 的全进程刷新取得拓扑，再刷新相关 PID；即使 `nothing()` 也会读取进程参数、线程信息 | 用 libproc 读取 PID、父 PID、进程名和启动时间；仅目标家族由 sysinfo 采详细数据；枚举失败保留原有 fallback |
| Unix 优先级 | 重复设置降优先级，每次在当前 nice 上再加 5；系统调用失败仍可能报告 Applied | 记录启动时继承的 nice，重复设置始终针对同一目标；失败、CPU weight、EcoQoS、Job 内存通知不支持时明确报告 Degraded |

`history_commands.rs`、`session_index_commands.rs`、`wallpaper_commands.rs`、`settings_commands.rs` 的命令名和前端成功返回值保持兼容。Tauri 同步命令运行在线程主循环，不能仅依赖前端 `Promise` 消除阻塞；有实际 I/O 的异步命令也需要把工作交给阻塞线程池。参考 [Tauri command 线程说明](https://v2.tauri.app/develop/calling-rust/)。

同时复用了已有审阅分支中消除 macOS dead-code 警告的相同改动，避免引入重复实现。

## 性能测量

同机 Apple Silicon，使用发布优化编译微基准，对比修改前与修改后的实际函数。以下数字只说明对应代码路径的成本，不代表端到端帧率、内存或整机 CPU 的相同比例改善。

| 测量 | 修改前 | 修改后 | 中位耗时减少 |
| --- | ---: | ---: | ---: |
| macOS 进程拓扑，约 1954 个进程，101 次，中位数 | 6.652 ms | 1.478 ms | 77.8% |
| 同一拓扑采样的 p95 | 8.820 ms | 1.813 ms | 79.4% |
| 本地终端 ASCII 输出的状态与提示处理，3000 块，9 批中位数 | 298.965 ms | 43.914 ms | 85.3% |
| 带 ANSI 与中文的输出，同上 | 207.360 ms | 36.805 ms | 82.3% |
| 权限确认输出，同上 | 197.166 ms | 39.555 ms | 79.9% |

终端基准覆盖状态判断和原来无条件执行的提示清洗，不包含 PTY、屏幕文本缓冲、IPC、xterm 或 GPU 绘制。基准不计被移除的原始字节/发送字符串复制。13 组兼容性样例对比了状态及实际通知判断；完整终端回归测试另行运行。

进程 CPU 的独立忙循环校验中，旧路径约 97.6%–101.2%，新路径完成预热后约 99.5%–100.8%，保持单核 100% 的口径。未将它描述成 CPU 读数准确率提升。

原始日志、基准源代码和本机环境记录保存在本机 `/Users/wuxiran/Documents/ChatGPT/ccpane/perf-evidence/2026-10-19/`：`inference-benchmark.log`、`benchmark-inference.py`、`benchmark-inference.rs`、`topology-release.log`、`benchmark-topology.rs`、`Cargo.toml`。复现时用该目录的 Cargo manifest 运行 release 的 `inference` 和 `topology` 两个目标；拓扑探针中的源文件路径需对应本机 checkout。

## 上轮 macOS 审阅发现

以下两项及原有包体超标已在后续提交修复，完整结果见 [性能与 macOS 后续修复](2026-10-19-performance-macos-followup.md)。本节保留发现时的证据。

### P1 区域截图没有 macOS 选区实现

`src-tauri/src/lib.rs:942` 的非 Windows 分支直接把 `selection` 设为 `None`。macOS 的截图入口会隐藏窗口、抓取屏幕，然后走“用户取消”分支，没有任何可产生成功截图的选区路径。`screenshot_service.rs` 的非 Windows 鼠标坐标还固定为 `(0, 0)`。

应单独接入 macOS 原生交互截图或实现 macOS 选区窗口，同时覆盖权限拒绝、取消、多显示器、Retina 缩放及原窗口可见性恢复。这是功能缺失，本次性能修改没有扩展截图交互。

### P2 性能记录遗漏系统托管的 WebKit 渲染进程

`cc-panes-core/src/services/system_stats_service/diagnostics.rs:47` 只把应用子树中的 WebKit/WebView 纳入诊断。现场 WebKit WebContent 进程的父 PID 为 1；最近 1000 个本地性能样本只有 app 和 daemon 两种角色。仅按父子关系无法覆盖这类 XPC 进程，不能据此判断 macOS 渲染器 CPU 或内存正常。

应以可验证的应用归属建立 WebKit 进程关联，避免把其他应用的 WebKit 进程算入 CC-Panes；在关联实现之前，渲染器指标应视为缺失。后台窗口、系统睡眠后的 timer lag 也不能直接解释为 UI 阻塞时间。

### 已修复的 macOS 与 Unix 问题

重复 nice 累加、优先级失败假报成功、主线程同步 I/O、托盘同步 daemon 请求和重复进程拓扑扫描已在本分支修复。原生菜单、剪贴板、PTY 的主线程约束和字节顺序没有改成无条件并行。

## 后续优化的依据

1. 先补 WebKit 归属测量，再用 10、25、50 个会话的固定输入回放测按键回显、切换延迟、renderer CPU/内存。当前安装版数据不构成本分支的 UI A/B 结果。
2. 会话索引和用量统计仍分别扫描同一批 JSONL；下一步优先共享文件元数据及解析结果。SQLite 写入和文件扫描直接无限并行会放大锁竞争和磁盘争用。
3. PTY 纯文本屏幕的单元格仍使用逐字符字符串分配；若端到端 profile 指向这里，应优化数据表示。把同一条 VT 字节流拆给多个线程会破坏 ANSI 状态机和序号顺序。
4. 其余同步命令仍应按触发频率及实际 I/O 耗时排序迁移；原生窗口、菜单操作不能机械地全部移到工作线程。

## 验证记录

- `cargo test --workspace --locked -j 2 --no-fail-fast`：2735 项通过，0 失败；最终新增采样回归后重新跑 core，1587 项通过，0 失败。工作区合计 3 个 ignored，包含本次手动基准。
- 显式排除既有 `delete_entry_trash_dir_symlink_trailing_slash_keeps_target` 测试：此前审阅已记录其 Finder/osascript 等待问题；未将它计为通过。
- `cargo clippy --workspace --locked -j 2 -- -D warnings`、`cargo fmt --all -- --check`、TypeScript 检查通过。
- 与变更接口及 macOS 终端有关的 6 个前端测试文件共 60 项通过。前端构建和 xterm 构建契约通过；性能脚本 11 项、发布元数据 9 项通过。
- 本分支入口包仍为 883.7 KiB gzip，超过原有 880 KiB 门禁。与基线既有审阅记录相同；本次没有改前端源文件或依赖。已有 audit 修复分支单独处理了该门禁。
- `cargo build --workspace --locked -j 2` 在本机 Apple Silicon/macOS 完成。四个 sidecar 已同步到本分支 `src-tauri/binaries` 及共享 debug runtime 的 `binaries`，逐一 SHA256 一致；Web 资源也已同步。
- 在 Git 临时树中依次合并 audit、deep-audit、chat-fork、agent-chat-timeline 四个分支，全部无文本冲突。该检查没有修改这些分支；组合版本未做运行时验证。

代码提交为 `81093a37`。修改保留在隔离 worktree `/Users/wuxiran/workspace/rust/cc-pane-perf-macos`，未推送、未替换正在运行的安装版。上述 microbenchmark 与原生测试已经执行；新版应用的长时间交互、睡眠恢复、截图权限和 Windows 原生行为未被这些测试覆盖。
