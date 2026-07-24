# Superset 竞品分析与可借鉴清单

> 来源：2026-07-23 对 [superset-sh/superset](https://github.com/superset-sh/superset) 的调研（GitHub releases / README / 官网 / 源码抽读）。
> 目的：这是与 CC-Panes 定位最接近的竞品（"本机并行编排多个 CLI 编码代理"），逐项对照功能差异，深挖其 git watcher 限流实现与 MCP 编排面，形成可借鉴清单。
>
> 相关文档：[23-ccpanel-competitor-evolution.md](./23-ccpanel-competitor-evolution.md)（CCPanel 竞品分析）、[multica-reference-analysis.md](./multica-reference-analysis.md)（Multica 参考分析）。

---

## 目录

1. [项目概况与时间线](#1-项目概况与时间线)
2. [功能逐项对照](#2-功能逐项对照)
3. [深挖一：git watcher 限流实现](#3-深挖一git-watcher-限流实现)
4. [深挖二：MCP "终端召唤终端" 对比](#4-深挖二mcp-终端召唤终端-对比)
5. [商业模式与许可](#5-商业模式与许可)
6. [可借鉴清单（P0/P1/P2）](#6-可借鉴清单)

---

## 1. 项目概况与时间线

**Superset**（superset.sh，与 Apache Superset 无关）——"Code Editor for the AI Agents Era - Run an army of Claude Code, Codex, etc. on your machine"。桌面应用（Electron）+ CLI + TS SDK + MCP Server，iOS 端在做。**仅支持 macOS**（Windows/Linux 无构建、未测试）。

- 2025-10-21 仓库创建 → 2025-12-01 首个 release v0.0.1 → 2026-07-21 v1.16.1
- 约 190 个 release（桌面/CLI 锁版本同步发，平均两三天一发），12.6k stars
- 技术栈：Electron、React、Tailwind、Bun、Turborepo、tRPC、Drizzle ORM、Neon（云 Postgres）+ Electric sync；TypeScript 占 93%
- monorepo：`apps/`（desktop、api、relay、web、admin、mobile、electric-proxy、docs、marketing）+ `packages/`（cli、sdk、mcp/mcp-v2、host-service、pty-daemon、workspace-fs、panes、port-scanner 等）

与 CC-Panes 技术路线正好相反：他们是全 TS + Electron + 云同步（v1.16 才开始补 host.db 本地优先）；CC-Panes 是 Tauri 2 + Rust + SQLite 本地优先。

## 2. 功能逐项对照

| 能力 | Superset | CC-Panes |
|---|---|---|
| 并行代理编排 | worktree 隔离为核心卖点，宣称 10~100+ 并行 | 多实例分屏 + Worktree 管理 + leader/worker 编排 |
| 支持代理 | 12+ 官方适配（Claude Code、Codex、Cursor Agent、Copilot、Gemini、Amp、OpenCode、Kimi Code 等），任意 CLI 免配置 | Claude Code + Codex 为主 |
| 内置终端 | 标签 + 无限分屏 + 预设布局 + 跨重启持久会话，⌘I 富文本提示编辑器（@-文件引用） | PTY + xterm.js 多标签分屏、共享 PTY、持久终端 daemon |
| 状态监控 | 侧边栏指示器、完成提示音、Dock 角标 | OSC/hook 双通道状态机（不靠文本猜测）、托盘 |
| Diff / 审查 | 内置 Diff 查看器：评论、编辑、直接提交推送 | Git 集成 + Local History Diff |
| 文件历史 | ❌ | ✅ Local History（版本 + 标签 + 分支感知），特色 |
| 端口 / 预览 | 应用内浏览器 + 按 worktree 端口检测预览 | 端口冲突检测 / 端口预留 |
| 定时自动化 | ✅ Automations（夜间跑代理任务），MCP 可创建 | ❌（Hooks/工作流非定时） |
| 远程 / 移动 | 远程工作区（云 relay）+ iOS（即将）+ 唤醒离线主机 | cc-panes-web + Flutter 移动端（已有） |
| MCP | 有（见 §4，发射后不管） | 有（launch_task + 读输出 + 注入 + leader/worker 闭环） |
| SDK | `@superset_sh/sdk`（TS） | ❌ |
| 第三方集成 | Slack、Linear（从 issue 建工作区）、一键交接 Cursor/VS Code | ❌ |
| Provider | OpenRouter、Bedrock、Vertex、Vercel AI Gateway | 多 Provider 管理 |
| 内置聊天 | ✅ 带工具审批和计划审查 | ❌ |
| 跨实例记忆/协作 | ❌ | ✅ 共享记忆池、plan 协作、todo 分派、Spec 绑定 |
| WSL / SSH 运行时 | ❌（macOS only） | ✅ local / WSL / SSH |
| 平台 | 仅 macOS | Windows 主战场，Tauri 跨平台 |

**结论**：Superset 强在产品打磨与生态集成（代理适配面、Slack/Linear、SDK、Automations、内置浏览器）；CC-Panes 强在编排深度（leader/worker 闭环、共享记忆、todo 分派）与 Windows/WSL 生态位——后者是 Superset 完全不覆盖的空白。

## 3. 深挖一：git watcher 限流实现

背景：CC-Panes 0.10.20 卡顿根因是 Local History **轮询扫描器**（见调查记录，commit 0d45dc7）。Superset 走的是纯事件驱动 + 四层防御，无任何文件系统轮询，在"多 worktree + agent 高频写文件"场景下已被验证可行。

源码位置：
- `packages/workspace-fs/src/watch.ts` — FsWatcherManager（@parcel/watcher native 监听）
- `packages/workspace-fs/src/throttled-worker.ts` — VS Code ThrottledWorker 移植
- `packages/workspace-fs/src/watch-event-coalescing.ts` — 纯函数事件合并
- `packages/host-service/src/events/git-watcher.ts` — GitWatcher 业务层

### 四层防御

**第 1 层：native watcher + ThrottledWorker（事件出口限流）**
- `@parcel/watcher`（FSEvents / ReadDirectoryChangesW），事件统一过 ThrottledWorker
- 参数：`MAX_WORK_CHUNK_SIZE = 500`（每块事件数）、`THROTTLE_DELAY_MS = 200`（块间隔）、`MAX_BUFFERED_EVENTS = 30_000`（缓冲上限，超了**整批丢弃**+ 一次性警告——宁丢事件不爆内存）
- 每个 watch root 独立 throttler（吵闹 worktree 不饿死安静 worktree）
- 内核 FSEvents overflow 单独处理：不逐条补，直接失效搜索索引待重建

**第 2 层：事件代数合并（纯函数）**
- 按路径合并：create+delete 抵消、update+delete 只留 delete
- delete/create 对按"同父目录 / 同文件名"启发式配对还原成 rename（Windows 的 ReadDirectoryChangesW rename 成对事件语义恰好需要这层）

**第 3 层：GitWatcher 双通道 + 差异化 debounce**

每 workspace 两个事件源汇入同一 debounce 批次：`.git/` 目录（`fs.watch` recursive，抓 commit/切分支/fetch 含外部终端操作）+ worktree 根（复用第 1 层 watcher，多路复用共享）。

- **静态噪音过滤表**：`.git/objects/**`、`lfs/**`、`logs/**`、`FETCH_HEAD` 直接丢弃——fetch/gc/repack 的大宗噪音，永远不改变 `git status` 输出（真状态变化必碰 refs/index/HEAD）。null 文件名 fail-open，宁多刷不漏
- **双档 debounce**：worktree 编辑 300ms（延迟敏感）；`.git/`-only 批次 1000ms 宽窗口且 **leading-anchored**（首事件定死 flush 时刻，后续搭车不重置）——rebase/`git am` 连环写不会无限推迟 flush，也不会打出几十个 git 子进程
- **批次路径上限 128 条**：超限降级为 broad invalidation（paths 置 null，下游全量刷新一次），且置 null 后窗口内跳过路径规范化

**第 4 层：生命周期对账**
- 唯一的"轮询"是每 30s 查 DB 对账该 watch 哪些 workspace（**不扫文件系统**）；watcher error 自摘，下轮 rescan 自动重建

### 对 Local History 事件化改造的映射

Rust 侧用 `notify` crate 可直接复刻：①静态 `.git/` 噪音过滤表 ②双档 debounce + leading-anchor ③有界批次 + broad invalidation 降级 ④背压整批丢弃。注意 Superset 只跑 macOS，Windows ReadDirectoryChangesW 的 buffer overflow 更易触发、rename 成对事件需自行验证（第 2 层 coalescing 正是解法）。其性能调查过程见其仓库 `plans/20260717-host-service-git-worker-pool.md`、`plans/v2-paths-worktree-perf-*.md`。

## 4. 深挖二：MCP "终端召唤终端" 对比

Superset `packages/mcp-v2/src/tools/` 按域组织：workspaces（CRUD）、agents（create/list）、terminals（create）、hosts、automations、tasks、projects。

- `agents_create`：在已有 workspace 启动 agent 会话（preset id 如 `claude`/`codex` 或自定义配置 UUID + prompt + attachmentIds 附件解析）
- `terminals_create`：worktree 内开新 PTY，可带一次性命令
- `workspaces_create` 支持 **create-and-spawn**：一次调用建 worktree + 带起 agents
- 所有调用带 `hostId` 经云 relay 路由 → agent 可在**组织内另一台在线机器**上召唤 agent
- 云端 MCP（`apps/api/MCP_TOOLS.md`）另有任务管理 + 设备编排（X-API-Key 编码 userId/orgId/defaultDeviceId）

**关键差异——召唤后的控制深度**：Superset 是"发射后不管"（terminals 只有 create.ts，agents 只有 create/list），没有读子会话输出、注入输入、kill、leader/worker 反馈、resume、共享记忆。其模型是"agent 派生 agent，**人来收**"（靠桌面 UI 闭环）；CC-Panes 是"agent 派生 agent，**agent 自己收**"（get_session_output / write_to_session / report_to_leader 完整闭环）。这是 CC-Panes 实质领先项。Superset 领先项：跨机器路由 + create-and-spawn 单调用工效。

## 5. 商业模式与许可

- **混合形态**：本地优先桌面应用 + 云端 SaaS 增值层。免费版 = 单用户本地工作区；Pro $20/月/人 = 远程工作区（Beta）+ Linear + 移动端；企业版 = SSO/审计/SCIM
- 云端承担：账号/组织、relay 中继（跨机器、手机、唤醒主机）、Neon + Electric 数据同步、Slack/Linear 集成
- **许可是 Elastic License 2.0（source-available，非 OSI 开源）**：代码几乎全公开（连 relay/api/admin 都在 monorepo），但 ①禁止第三方托管服务 ②禁止绕过 license key 门控（付费功能代码在仓库里、由 key 门控）③云端生产设施独占
- 若 CC-Panes 未来做增值层，ELv2/BSL"源码全公开 + 禁托管 + key 门控"是本赛道主流模式；且 CC-Panes 本地优先架构对云的依赖面天然更小

## 6. 可借鉴清单

### P0（直接解决现有痛点）

1. **Local History 事件化改造**：照 §3 四层防御替换轮询扫描器——`.git/` 噪音过滤表 + 双档 leading-anchored debounce + 有界批次降级 + 背压丢弃。这是 0.10.20 卡顿问题的正解方向
2. **终端运行时驱逐**（他们 v1.16.0 性能项）：不活跃终端的渲染/缓冲资源回收，多实例场景直接受益

### P1（补产品短板，实现成本可控）

3. **定时 Automations**：Hooks 系统已有执行面，补 cron 调度 + MCP 暴露即可（"夜间分类 issue / 更新依赖"类场景）
4. **按 worktree 端口检测 + 一键预览**：现有 list_port_conflicts 已有底子，补"端口 → 应用内/外部浏览器打开"链路
5. **create-and-spawn 单调用**：launch_task 支持"建 worktree + 起会话"一步完成，减少 MCP 往返
6. **提示编辑器 @-文件引用**：多行提示 + 文件引用（另可顺带解决 launch_task 多行 prompt 截断问题的交互面）

### P2（战略方向，需权衡）

7. **扩大代理适配面**：Gemini CLI / OpenCode / Copilot 等——"If it runs in a terminal, it runs on it" 的免配置兜底 + 自定义代理图标
8. **TS SDK**：把 MCP/REST 面包成 npm 包，降低生态接入门槛
9. **跨机器编排**：CC-Panes 已有 WSL/SSH 运行时，向"remote host 注册 + 路由"演进可对标其 relay（但走本地组网/自托管路线，不必依赖云）
10. **Slack/Linear 类集成**："从 issue 建任务"入口

### 不必学的

- 云优先数据层（Neon/Electric）：他们自己正在回退成本地优先，CC-Panes 起点即正确
- Electron 路线：Tauri 的资源占用优势在"跑 10 个实例"场景反而更放大
- 状态监控走 UI 提示音/角标即可的思路：CC-Panes 的 OSC/hook 状态机语义更强，勿倒退
