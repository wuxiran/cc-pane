# 合并主线新增 8 项问题修复

修复基线：`dev/v0.12.22` 的 `65ab7bb59df330f7dfeb6773a2956193b07c82d8`。
工作分支：`codex/fix-main-review-20261021`。
修复期间主线更新为 `7dd09e43`（PR #84），已通过 `dd70f7b7` 合入本工作分支，保留并行任务改动；没有向主线写入本轮修复。
原始问题与复现见 [本轮审阅](2026-10-21-merged-main-review.md)。

按 P1、P2 顺序实施。全部修改位于独立工作树，独立安装 npm 10 锁定依赖，并使用本任务专用 Rust target；没有切换或修改主线及其他工作树，也没有停止现有应用、daemon 或终端会话。

## 修复内容

| 编号 | 优先级 | 修复与回归重点 |
| --- | --- | --- |
| H01 | P1 | 后续快照继续读取 baseline 已知文件，避免忽略规则造成假删除；保留真实删除语义，不收录新 ignored 文件。验证忽略后的编辑、过期预览拒绝及源 Git index 不变。 |
| H02 | P1 | MCP 状态按配置目标分桶，请求按目标和代次校验；表单及保存绑定打开时的目标。覆盖双标签同名服务器、乱序响应、清空与迟到保存。 |
| H03 | P1 | Todo 按任务和字段编辑版本管理草稿，提交快照只确认已发送版本。子任务刷新、保存期间改回旧值、失败和乱序确认均保留后续编辑；创建期间的新编辑绑定返回的任务 ID，后续保存走 update。 |
| H04 | P2 | 使用可逆 argv 文本编解码，保留空参数、空白、引号、换行及反斜杠。不进行 shell 展开；非法引号或 NUL 在任何写操作前报错，提供双语说明。 |
| H05 | P2 | 导航、上一级、面包屑、编辑器定位及工作空间公共根共用路径工具。保留盘符根和 UNC/WSL 共享根，修复重复分隔符，并保留 POSIX 文件名反斜杠与 SSH URI。旧版持久化的裸盘符迁移回根目录；合法 drive-relative 路径不被强改。 |
| H06 | P2 | 快照识别文件与目录的形态变化；采纳按依赖删除阻挡文件、移除必要空目录并创建目标。操作日志逆序回滚，未知、ignored、未选择或并发新增文件阻止目录替换，符号链接防护保留。Windows 保存 owner/group/DACL，修改文件前预检能否完整重建目录权限；恢复失败不通过默认权限重建后代。覆盖两个方向、暂存与未暂存、不同选择顺序及失败回滚。 |
| H07 | P2 | 创建、更新、删除和默认项切换统一持锁复制配置，原子落盘成功后才发布内存。覆盖真实 I/O 失败、默认项联动、后续无关保存不夹带失败修改和重启。原子写工具不再在 Windows rename 失败后删除旧文件重试。 |
| H08 | P2 | macOS 仅在 EPERM、已观察到组长退出、完整进程组检查确认没有存活成员时消除误报。组长始终保持未回收；权限、检查失败和存活成员仍报错。普通成功/非零退出命令新增 executionError 断言，现有后台清理回归继续执行。 |

MCP 编辑逻辑、Todo 草稿和 LaunchProfile 写事务拆到独立模块；`ProjectMcpSection` 从 661 降到 590 行，`TodoManager` 从 463 降到 432 行，文件行数基线只下调。没有改依赖版本或放宽测试、覆盖率及包体积门槛。

## 验证

以下为合入主线 `7dd09e43` 后重新执行的最终验证。合入前也执行过完整套件；最终数据不混用两个代码快照。

| 门禁 | 结果 |
| --- | --- |
| `npx vitest run --coverage --maxWorkers=4 --coverage.thresholds.autoUpdate=false` | 657 个文件、6325 项测试通过，0 失败 |
| 前端覆盖率 | statements 79.30%、branches 72.47%、functions 76.76%、lines 82.10%；保留最新主线提高后的门槛，关闭自动修改阈值 |
| `npm run test:contracts` | 18 项 worker 报告及打包内容契约测试通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run build` 及 xterm 构建验证 | 通过 |
| `npm run check:bundle` | 入口及首屏 JS 为 878.4 KiB gzip，低于 880 / 1100 KiB 预算 |
| `cargo test --workspace --locked --no-fail-fast -j 2` | 3078 passed、0 failed、5 ignored；按每个测试 binary 的最终汇总计数，未重复计算子进程 fixture 输出 |
| `cargo clippy --workspace --locked -j 2 -- -D warnings` | 通过 |
| `cargo fmt --all -- --check` | 通过 |
| 四个侧车的 debug build 和同步 | 通过；源二进制、独立工作树 `src-tauri/binaries`、本任务 target 的 `debug/binaries` 三处 SHA256 一致，未重启现有应用 |
| Node 性能与发布资产脚本测试 | 26 passed |
| 主题对比度 | 通过 |
| Windows H06 模块及测试跨目标编译 | `x86_64-pc-windows-msvc` 的独立最小 harness 检查通过；真实源码哈希匹配，仅错误转换 stub，不等同于整个 Windows workspace 或原生运行 |

5 项忽略测试来自既有联网安装/性能和运行环境诊断配置，本轮没有新增忽略项。第一轮前端完整测试发现请求表资源归属清单缺失；按现有规则声明 MCP 目标和 Todo 任务的归属及清理方式后，单项门禁 3 条通过，并重新执行完整套件至全绿。

提交顺序：`ad555c9e`（3 个 P1）、`6607c8c2`（P1 保存竞争边界）、`03d1c452`（5 个 P2 及其回归）。

主线推进后，`sessionScopedResources.test.ts` 出现唯一文本冲突：保留主线的 `orchestratorProjection` 归属声明和本轮的 MCP/Todo 声明，移除已被主线重构替代的旧 `useOrchestratorStore` 声明。其余本轮修复文件在整合时没有变化。整合在独立修复分支执行，原主线工作目录及未跟踪文件保持原状。

最终分支包含主线 `7dd09e43`，对该主线的提交树合并预检通过。并行分支 `db3d766c` 与该主线的 tree 相同，已通过主线 squash 提交纳入；没有再次合并旧分支或修改其工作树。

证据目录：`/Users/wuxiran/Documents/ChatGPT/ccpane/review-evidence/2026-10-21-main-fixes/`；最新主线整合后的门禁与侧车哈希记录位于 `combined-main/`。性能/发布脚本、主题和 Windows 模块编译检查的被测源码在整合时未变化，沿用该目录下已通过的对应检查记录。

## 平台边界

本次执行环境为 macOS。Windows 路径行为通过实际前端 Store/组件与路径测试验证；Windows 原生文件访问、ACL/锁定文件回归、桌面应用与安装包需 Windows runner/主机执行，不能据 macOS 结果宣称已完成这些验收。

macOS 退出组判断依据本机子进程回归及 [Apple libproc 实现](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c)。Windows 文件替换使用 [Rust 标准库 rename 语义](https://doc.rust-lang.org/std/fs/fn.rename.html)，保留失败时的旧目标。
