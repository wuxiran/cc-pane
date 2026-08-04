# 0.11.2 会话历史 MVP Worker 报告

## 实现摘要

- `8b44640 feat: 新增会话历史索引服务`
  - 新增 V24 `session_index` / `session_scan_state`、算法版本门、Claude/Codex JSONL 解析、300 秒后台增量扫描和首扫 WSL 闸门。
- `d6f96d0 feat: 提供会话历史查询接口`
  - 新增 scope/搜索/CLI/分页查询、Tauri 命令、REST 镜像和 Codex rollout 存在性预检。
- `8e9a3d3 feat: 添加会话历史右坞视图`
  - 新增 `sessionIndexService` 双通道服务、RightDock 会话历史视图、模块注册表入口、persist 白名单、双语 i18n 和聚焦测试。
  - 视图支持全部/当前工作空间/当前项目、300ms 搜索防抖、Claude/Codex chip、100 条分页、手动刷新、活动项目跟随。
  - Resume 复用 `buildLaunchRecordTerminalOptions`，再以索引中的 `cwd`、CLI、session ID 和 WSL distro/remotePath 收窄；Codex rollout 确定不存在时不启动，入口转为禁用并显示告警。

## 验收项自查

- [x] Claude + Codex 索引模型、解析、列表展示字段（末条摘要、消息数、CLI、相对时间、项目名）已接通并有固定 fixture / 组件测试。
- [x] 三档 scope、搜索、CLI 筛选可组合；“当前项目”随 RightDock 共享活动上下文变化后重新查询。
- [x] Claude/Codex resume 参数有组件级断言；跨 workspace 的 WSL 会话使用所属 workspace 配置；Codex 无效 rollout 不降级为静默新会话。
- [x] mtime+size 未变时跳过正文；算法版本变化清索引重扫；手动刷新后重新读取当前组合查询。
- [x] 模块通过注册表进入 RightDock、Command Palette、Settings；RightDock persist merge 白名单允许恢复 `sessionHistory`。
- [x] 中英文 key 对等；新 UI 无 hex/直接色值，状态告警使用主题 token。
- [ ] Windows 桌面实机显示、WebView2 交互和真实 Claude/Codex/WSL resume 未在当前 WSL 环境验证，需 Windows host 收口。

## 每周期扫描 IO 量级

当前 WSL 用户目录按生产扫描根实测：

| 根目录 | JSONL 文件 | 目录 | JSONL 原始字节 |
|---|---:|---:|---:|
| `~/.claude/projects` | 22 | 12 | 936,190 B |
| `~/.codex/sessions` | 1,431 | 115 | 4,788,297,493 B |
| 合计 | 1,453 | 127 | 4,789,233,683 B（约 4.5 GiB） |

- 稳定 300 秒周期：遍历约 127 个目录，对 1,453 个 JSONL 做目录项/mtime/size 元数据检查；全部未变化时正文读取为 0 B。聚焦测试 `second_scan_of_unchanged_file_reads_zero_transcript_bytes` 实测第二轮 `files_skipped=1`、`files_parsed=0`、`bytes_read=0`。
- 首轮或算法版本变化：当前数据集正文基线约 4.5 GiB；末条摘要反向尾读每文件最多再读 8 KiB，因此当前集合单轮上界约 4,801,136,659 B（仍约 4.5 GiB）。以后仅改动文件产生正文 IO。
- 启动首扫只包含本地两个根，不执行 WSL discovery；测试确认即使缓存标记 running 也不加入 WSL 根。周期扫描仅在 WSL VM 已运行且设置允许时加入 WSL Codex 根。
- 上述文件/目录数量来自当前 WSL 文件系统实测；Windows `\\wsl$` 侧的运行中发行版规模未在本环境测量。

## 聚焦验证

- `cargo fmt --all -- --check`：通过。
- `cargo test -p cc-panes-core -- session_index`：11 passed，0 failed，覆盖解析、增量跳过、版本门、查询和 WSL 闸门。
- `cargo test -p cc-panes-web -- agent_sessions`：5 passed，0 failed，含 session index REST 组合查询。
- `CARGO_TARGET_DIR=/tmp/ccpanes-sessionhist-target.ghVOqn cargo test -p cc-panes -- session_index`：1 passed，0 failed，Tauri 参数映射通过。
- `CARGO_TARGET_DIR=/tmp/ccpanes-sessionhist-target.ghVOqn cargo clippy -p cc-panes-core -p cc-panes-web -p cc-panes -- -D warnings`：通过。
- `npx vitest run web/components/rightdock web/modules web/test --maxWorkers=1 --no-fileParallelism`：7 files / 40 tests passed。
- `npx vitest run web/services/sessionIndexService.test.ts web/stores/useRightDockStore.test.ts web/stores/useModulePrefsStore.test.ts --maxWorkers=1 --no-fileParallelism`：3 files / 18 tests passed。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。

共享 `../cc-book-target` 曾把另一个 worktree 的旧 `cc-panes-core` rlib 误判为 fresh，导致 Tauri 命令首次出现不存在新导出的假失败；使用独立临时 target 从当前源码完整编译后通过。未运行全量测试，符合 worker 聚焦测试约束。

## 已知限制

- 当前环境是 WSL，不能据此声明 Windows Tauri 启动、WebView2、真实 WSL UNC 枚举或 CLI resume 已实机通过。
- 首次建立索引会线性读取全部本地转录；当前样本库约 4.5 GiB，首次扫描成本明显，后续稳定周期由 mtime/size 跳过消除正文 IO。
- Codex rollout 预检返回 `null` 或调用失败时按底层约定 fail-open，但会显示告警；仅 `false` 确定不存在时禁用。
- 未 push；`PLAN.md`、`WORKER-INSTRUCTION.md` 保持原样且未纳入提交。
