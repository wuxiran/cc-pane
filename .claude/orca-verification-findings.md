# Orca §6 双方独有功能源码核验发现

核验日期：2026-07-27

CC-Panes 源码：`/mnt/d/04_workspace_rust/cc-book`

Orca 源码：`/mnt/d/04_workspace_rust/references/orca`（快照，只按当前源码取证）

## 判定口径

- `CONFIRMED_PRESENT`：读到实际数据模型、执行路径或 UI/IPC 消费链，不以目录名或类型名代替实现。
- `CONFIRMED_ABSENT`：在约定源码目录内用至少 5 个同义词/别名搜索，并阅读最接近的同名或相邻模块后仍未发现同类实现。
- `INCONCLUSIVE`：源码能证明相邻能力，但不足以证明题目中的定性强弱或运行时语义。
- CC-Panes 的缺失搜索统一覆盖：`web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters`。
- Orca 的缺失搜索统一覆盖：`src`。
- 本报告只核源码存在性和能力边界，不基于目录名、文件名、产品文案或 Git 历史下结论。

## 总表

| 条目 | 原 §6 判定 | 本次判定 | 关键证据 `file:line` | §6 需订正 |
|---|---|---|---|---|
| A1 Local History | CC 有、Orca 无 | CC `CONFIRMED_PRESENT`；Orca `CONFIRMED_ABSENT` | `cc-panes-core/src/models/history.rs:5-25,164-195`；`../references/orca/src/renderer/src/components/right-sidebar/AiVaultPanel.tsx:13-44` | 否 |
| A2 共享记忆池 | CC 有、Orca 无 | CC `CONFIRMED_PRESENT`；Orca `CONFIRMED_ABSENT` | `cc-memory-mcp/src/handler.rs:30-50`；`../references/orca/src/main/memory/collector.ts:5-17` | 否 |
| A3 resume 会话链 | CC 有、Orca 无 | 双方 `CONFIRMED_PRESENT` | `src-tauri/src/services/orchestrator_service.rs:6103-6139`；`../references/orca/src/shared/ai-vault-types.ts:298-344` | **是** |
| A4 Provider 多渠道热切换 | CC 有、Orca 无 | CC 精确能力 `CONFIRMED_ABSENT`；Orca 托管账号切换 `CONFIRMED_PRESENT`，是否改变已运行 CLI 为 `INCONCLUSIVE` | `cc-panes-core/src/services/terminal_service.rs:368-380`；`../references/orca/src/main/claude-accounts/service.ts:334-380` | **是** |
| A5 Spec/Todo 双向绑定 | CC 有、Orca 无 | CC `CONFIRMED_PRESENT`；Orca `CONFIRMED_ABSENT` | `cc-panes-core/src/services/spec_service.rs:44-135,248-253`；`../references/orca/src/cli/specs/index.ts:1-35` | 否 |
| A6 Dev/Release 隔离并行 | CC 有、Orca 无 | 双方 `CONFIRMED_PRESENT` | `cc-panes-core/src/utils/app_paths.rs:4-29`；`../references/orca/src/main/startup/configure-process.ts:163-195` | **是** |
| A7 OSC + hook 双通道状态机 | CC 有、Orca 无 | 双方 `CONFIRMED_PRESENT` | `cc-panes-core/src/services/session_state_machine.rs:30-49,159-201`；`../references/orca/src/shared/agent-status-osc.ts:4-85` | **是** |
| A8 中文优先工作流深度 | CC 独有 | 双方 i18n `CONFIRMED_PRESENT`；“深度”比较 `INCONCLUSIVE` | `web/i18n/index.ts:39-92`；`../references/orca/src/renderer/src/i18n/supported-languages.ts:18-40` | **是（降级表述）** |
| B1 ephemeral VM | §6 漏记 | Orca `CONFIRMED_PRESENT`；CC `CONFIRMED_ABSENT` | `../references/orca/src/shared/ephemeral-vm-recipe-runner.ts:18-115,147-275` | **是** |
| B2 工作项系统集成 | 只写 GitHub/Linear 看板 | Orca 4 个任务源 `CONFIRMED_PRESENT`；CC `CONFIRMED_ABSENT` | `../references/orca/src/shared/task-providers.ts:1-8`；`../references/orca/src/shared/task-source-context.ts:12-56` | **是** |
| B3 Hosted Review | §6 漏记 | Orca `CONFIRMED_PRESENT`；CC `CONFIRMED_ABSENT` | `../references/orca/src/shared/hosted-review.ts:3-39,60-89` | **是** |
| B4 Automations | §6 漏记 | Orca `CONFIRMED_PRESENT`；CC `CONFIRMED_ABSENT` | `../references/orca/src/shared/automations-types.ts:4-18,71-125` | **是** |
| B5 Native Chat + Notebook | §6 漏记 | Orca 两项 `CONFIRMED_PRESENT`；CC 两项 `CONFIRMED_ABSENT` | `../references/orca/src/renderer/src/components/native-chat/NativeChatView.tsx:58-154`；`../references/orca/src/main/ipc/notebook.ts:102-255` | **是** |
| B6 遥测/可观测性/崩溃上报 | §6 漏记 | Orca 三项 `CONFIRMED_PRESENT`；CC 对等管线 `CONFIRMED_ABSENT` | `../references/orca/src/main/telemetry/client.ts:19-116,163-203`；`../references/orca/src/renderer/src/components/crash-report/CrashReportDialog.tsx:16-78` | **是** |
| B7 多账号与限流 | 已写“账号切换与用量追踪” | Orca `CONFIRMED_PRESENT`；CC 对等能力 `CONFIRMED_ABSENT` | `../references/orca/src/main/codex-accounts/service.ts:179-204,352-403`；`../references/orca/src/main/rate-limits/service.ts:185-264,347-443` | 否（原文已覆盖） |
| B8 Computer Use + Android emulator | 已列两项 | Orca `CONFIRMED_PRESENT`；CC 对等能力 `CONFIRMED_ABSENT` | `../references/orca/native/computer-use-linux/runtime.py:1-75,649-724`；`../references/orca/src/main/emulator/android/android-stream-controller.ts:19-66` | 否 |
| B9 i18n | §6 未列 | 双方 `CONFIRMED_PRESENT` | `web/i18n/index.ts:39-92`；`../references/orca/src/renderer/src/i18n/i18n.ts:17-85` | 否 |
| B10 Pet | §6 当前未列 | 双方 `CONFIRMED_PRESENT` | `src-tauri/src/services/ccchan_service.rs:111-155,275-327`；`../references/orca/src/main/ipc/pet.ts:238-290,381-409` | 否 |

## A 组逐条核验

### A1. Local History（文件版本 + 标签 + 分支感知）

**结论：CC-Panes `CONFIRMED_PRESENT`；Orca `CONFIRMED_ABSENT`。原 §6 此项成立。**

CC-Panes 的 `FileVersion` 明确持有文件路径、哈希、删除标记和分支，`HistoryLabel` 持有来源、快照引用和分支（`cc-panes-core/src/models/history.rs:5-25,164-195`）。存储层建立 `file_versions`、`labels`、`label_snapshots` 以及 branch 索引（`cc-panes-core/src/repository/history_file_repo.rs:61-120`）；服务层把文件修改、删除、分支切换建模为事件，并在切换时创建自动标签（`cc-panes-core/src/services/history_service.rs:32-49,247-276`）。这不是 Git commit history 的换名。

实际执行：

```bash
rg -n -i -e 'local history|file history|file version|version snapshot|branch-aware history|branch aware history|snapshot label|history label|restore version' src
```

结果不是零命中，共 7 行，因此逐项追读而不是把“弱命中”算 PRESENT：

- `workspace-session-terminal-buffers.ts` 的 “local history” 指 daemon terminal scrollback/cold restore（`../references/orca/src/shared/workspace-session-terminal-buffers.ts:120-126`）。
- `last-status file version mismatch` 指 hook 状态文件 schema version（`../references/orca/src/main/agent-hooks/server.ts:2036-2043`）。
- `remoteBrowseLocalHistory` 位于 `AiVaultPanel` 文案组，紧邻 “Agent Session History / Resume past sessions”，指本机 AI transcript 历史（`../references/orca/src/renderer/src/i18n/locales/en.json:10456-10482`）；其实现导入 session filter、scope、resume actions 和 transcript log open（`../references/orca/src/renderer/src/components/right-sidebar/AiVaultPanel.tsx:13-44,240-270`）。
- 其余 “snapshot” 命中位于 web session 同步测试，指 UI state/epoch snapshot。
- Orca 的另一个 history 面板消费的是 `GitHistoryItem`、commit files 和 refs（`../references/orca/src/renderer/src/components/right-sidebar/GitHistoryPanel.tsx:7-19,67-80,236-250`），仍不是独立文件快照、标签和分支感知版本库。

搜索词已经覆盖 9 个别名；读过 AI Vault、terminal history、hook status file 和 Git history 实现，未发现与 CC-Panes Local History 同类的数据模型、快照写入、标签或恢复链。

### A2. 共享记忆池（跨 Claude/Codex）

**结论：CC-Panes `CONFIRMED_PRESENT`；Orca `CONFIRMED_ABSENT`。原 §6 此项成立。**

CC-Panes MCP handler 暴露并分发 `memory_add/search/update/delete/daily_report`（`cc-memory-mcp/src/handler.rs:30-50,55-100`）；repository 持久化 title/content/scope/workspace/project/session/tags，并提供 FTS5 搜索与 LIKE 降级（`cc-memory/src/repository.rs:15-50,151-168`）。

实际执行：

```bash
rg -n -i -e 'memory_add|memory_search|semantic memory|shared memory pool|cross-agent memory|cross agent memory|memory scope|FTS memory|long-term memory' src
```

结果：零命中（9 个别名）。进一步阅读同名目录后确认，Orca `memory` 是资源监控：collector 用 Electron metrics、PTY 进程树和 RSS/CPU 构建趋势快照（`../references/orca/src/main/memory/collector.ts:5-17,30-67,75-118`），IPC 只有 `memory:getSnapshot`（`../references/orca/src/main/ipc/memory.ts:1-8`），PTY registry 只保存 PTY/worktree/session/pid 归属（`../references/orca/src/main/memory/pty-registry.ts:1-43`），renderer slice 只拉取资源快照（`../references/orca/src/renderer/src/store/slices/memory.ts:1-44`）。未发现 AI 语义记忆写入、检索或跨 agent scope。

### A3. resume 会话链

**结论：双方均 `CONFIRMED_PRESENT`。原 §6 “Orca 无”错误。**

CC-Panes 的 `list_launch_history` 返回 `resumeSessionId/cliTool/runtimeKind`，源码还明确给出 `list_launch_history -> launch_task(resumeId)` 流程（`src-tauri/src/services/orchestrator_service.rs:6103-6139`）；`launch_task` 参数包含 `resumeId`（`src-tauri/src/services/orchestrator_service.rs:2249-2267`），TerminalService 对 resume id 归一化并传入各 CLI 启动构造（`cc-panes-core/src/services/terminal_service.rs:1335-1354,1541-1546,1835-1883`）。前端同样通过 Tauri/HTTP 读取 launch history（`web/services/historyService.ts:65-73`）。

Orca 的 AI Vault 不是密钥库：它按 agent 生成真实 resume invocation，Codex 用 `resume`，Rovo 用 `--restore`，Kimi/OpenCode/Pi 用 `--session`，其余多种 agent 使用各自 `--resume/--conversation` 形式（`../references/orca/src/shared/ai-vault-types.ts:298-344`）。IPC 根据 local/runtime/SSH host 准备 resume（`../references/orca/src/main/ipc/ai-vault-resume.ts:17-38`）；休眠 agent 激活时还会按 provider-session claim 去重并重新拉起（`../references/orca/src/renderer/src/lib/resume-sleeping-agent-session.ts:140-214`）。因此 Orca 不只“有 resume”，还实现了休眠会话唤醒和重复 claim 防护。

### A4. Provider 多渠道热切换

**结论：CC-Panes 的“已运行会话热切换” `CONFIRMED_ABSENT`；Orca 的托管账号选择 `CONFIRMED_PRESENT`，但它是否改变已运行 CLI 的 provider/account 不能由这些源码证明，精确热切换语义为 `INCONCLUSIVE`。原 §6 对 CC-Panes 的表述过度。**

实际执行：

```bash
rg -n -i -e 'provider hot switch|hot-switch provider|ProviderSwitch|switchProvider|change active provider|reload provider credentials|replace running provider|live provider switch|runtime provider swap' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果只有一处命中，而且是明确的未来预留：`ProviderSwitch` 落地时再给 `KillReason` 加变体（`cc-panes-core/src/services/terminal_service.rs:368-380`）。已读相邻实现显示当前能力是 provider CRUD、设默认和启动时选择：设置页只有 edit/delete/setDefault/duplicate（`web/components/providers/ProvidersPanel.tsx:134-187,289-353`），卡片主操作是设默认并提供 CRUD（`web/components/providers/ProviderCard.tsx:230-253`），后端 `set_default/get_env_vars(provider_id)` 只控制持久化默认项和启动注入（`cc-panes-core/src/services/provider_service.rs:241-270`）。没有把新凭证注入已运行 PTY/CLI 的执行路径。

Orca 确实有托管账号选择：Claude 切换会写 active selection、同步 runtime auth，并刷新对应 rate limits（`../references/orca/src/main/claude-accounts/service.ts:334-380,434-443`）；Codex 支持按 host/WSL target 选择账号并同步 runtime home（`../references/orca/src/main/codex-accounts/service.ts:179-204,352-403`）。但“更新共享 auth/runtime home”不自动等价于已运行 CLI 进程立即切换身份；相反，Claude runtime auth 在 live PTY 持有凭证时会保留已变化凭证并延后单次 OAuth token 刷新（`../references/orca/src/main/claude-accounts/runtime-auth-service.ts:388-425`）。本报告不把账号选择扩大解释为 active-session hot switch。

建议 §6 把此项改成“Provider 凭证预设、默认项与启动时选择”，不要写“热切换”。

### A5. Spec / Todo 双向绑定

**结论：CC-Panes `CONFIRMED_PRESENT`；Orca `CONFIRMED_ABSENT`。原 §6 此项成立。**

CC-Panes 创建 Spec 时同时创建 `.spec.md` 文件和 `todoType=spec` 的 Todo，写回 `todo_id`，并把初始 subtasks 同步到文件（`cc-panes-core/src/services/spec_service.rs:44-135`）。`sync_tasks` 持项目锁执行（`cc-panes-core/src/services/spec_service.rs:246-257`），渲染 Markdown checkbox（`cc-panes-core/src/services/spec_service.rs:477-529`）；Tauri 命令暴露 `sync_spec_tasks`，终端退出时再次回收 checkbox 改动（`src-tauri/src/commands/spec_commands.rs:68-108`）。

实际执行：

```bash
rg -n -i -e 'sync_spec_tasks|\.spec\.md|SpecTodo|spec task binding|tasks checkbox sync|active spec|archive spec|spec todo|bidirectional spec' src
```

结果：零命中（9 个别名）。同名目录也已读：`src/cli/specs/index.ts` 只是把 core/file/automation/browser/orchestration/computer 等 `CommandSpec[]` 汇总成 CLI 命令表（`../references/orca/src/cli/specs/index.ts:1-35`）；例如 `core.ts` 的元素是 `path/summary/usage/allowedFlags/examples` 命令声明（`../references/orca/src/cli/specs/core.ts:1-31`），`automations.ts` 也是命令参数规格（`../references/orca/src/cli/specs/automations.ts:24-68`）。未发现 Spec 文档与 Todo checkbox 双向同步。

### A6. Dev / Release 隔离并行运行

**结论：双方均 `CONFIRMED_PRESENT`。原 §6 “Orca 无”错误。**

CC-Panes 用 `cfg!(debug_assertions)` 选择 `.cc-panes-dev` 或 `.cc-panes` 配置/数据根（`cc-panes-core/src/utils/app_paths.rs:4-29`），dev 配置使用独立 identifier `com.ccpanes.dev`、scheme 和窗口标题（`src-tauri/tauri.dev.conf.json:1-20`）。

Orca dev/E2E 先设置独立 `userData`，普通 dev 默认落 `orca-dev`，避免覆盖 packaged runtime pointer（`../references/orca/src/main/startup/configure-process.ts:163-195`）。single-instance lock 明确依赖隔离后的 `userData` namespace（`../references/orca/src/main/startup/single-instance-lock.ts:20-34`），且普通 dev 默认跳过单实例锁以允许多 worktree dev 并行（`../references/orca/src/main/startup/single-instance-lock.ts:53-60`；调用顺序见 `../references/orca/src/main/index.ts:597-620`）。

### A7. OSC + hook 双通道状态机

**结论：双方均 `CONFIRMED_PRESENT`。原 §6 和 §4 的 “Orca hook HTTP 单通道”错误。**

CC-Panes 的 PTY parser 识别 OSC 777 hook marker 和 OSC 133 command boundary，并明确说明与 HTTP hook 双份到达、由状态机去重（`cc-panes-core/src/services/terminal_service/osc_state_detect.rs:1-20,138-177`）。状态机建模 `Http/Osc` 两个通道、2 秒跨通道去重窗口和 4 条去重记忆（`cc-panes-core/src/services/session_state_machine.rs:30-49`），`on_event_with_channel` 实际执行跨通道去重（`cc-panes-core/src/services/session_state_machine.rs:159-201`）。

Orca 有 stateful OSC 9999 parser，支持跨 chunk、BEL/ST 终止符、64 KiB pending 上限，并从 PTY 输出剥除控制序列（`../references/orca/src/shared/agent-status-osc.ts:4-85`）；PTY transport 在写入 xterm 前解析并调度 payload side effects（`../references/orca/src/renderer/src/components/terminal-pane/pty-transport.ts:410-443`）。同时 main process 注册 HTTP hook listener 并把标准化状态送给 renderer（`../references/orca/src/main/index.ts:1211-1281`）。OSC 语义比 hook payload 窄，但“只有 hook 单通道”不成立。

### A8. 中文优先工作流深度

**结论：双方 i18n 均 `CONFIRMED_PRESENT`；“中文优先工作流深度”是复合定性，源码不足以证明 Orca 缺失，整体 `INCONCLUSIVE`。§6 应改成带指标的优势描述，而非独有功能。**

CC-Panes i18n 内置 `zh-CN/en` 两种语言、各 15 个 namespace，默认和 fallback 都是 `zh-CN`（`web/i18n/index.ts:39-92`）。Orca 显示 system/en/zh/ko/ja/es 六个选择（五种明确语言），中文不是缺失项（`../references/orca/src/renderer/src/i18n/supported-languages.ts:18-40`）；English eager load，es/ja/ko/zh 按需加载（`../references/orca/src/renderer/src/i18n/i18n.ts:17-85`）。

可复现代理指标：

```bash
# CC-Panes
rg --files docs -g '*.md' | wc -l
# => 112
rg -l '[一-龥]' docs -g '*.md' | wc -l
# => 107
find web/i18n/locales -type f -name '*.json' | sort
# => zh-CN 15 个 + en 15 个

# Orca
rg --files docs -g '*.md' | wc -l
# => 53
rg -l '[一-龥]' docs -g '*.md' | wc -l
# => 6
find src/renderer/src/i18n/locales -type f -name '*.json' | sort
# => en/es/ja/ko/zh 各 1 个 catalog
```

这些指标支持“CC-Panes 默认中文、中文文档覆盖更高”，但不能把 skill/plan→codex 方法论的质量压缩成 presence/absence，也不能据此说 Orca 没有中文工作流。

## B 组逐条核验

### B1. ephemeral VM（临时 VM 运行时 + recipe）

**结论：Orca `CONFIRMED_PRESENT`；CC-Panes `CONFIRMED_ABSENT`。§6 漏记。**

Orca recipe runner 不是空壳类型：它构造上下文、spawn create 命令、解析结果，并实现 destroy/suspend/resume 生命周期（`../references/orca/src/shared/ephemeral-vm-recipe-runner.ts:18-115,147-275`）。runtime store 把 VM record、status、cleanup、workspace/SSH/runtime 关联持久化到受限 JSON 文件（`../references/orca/src/shared/ephemeral-vm-runtime-store.ts:16-51,54-114`）。

实际执行：

```bash
rg -n -i -e 'ephemeral vm|temporary vm|disposable vm|virtual machine recipe|sandbox runtime|vm recipe|microvm|firecracker' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果：零命中（8 个别名）。已读最接近的 Runner：它是 profile CRUD、端口冲突和本机/WSL/SSH 进程实例登记（`cc-panes-core/src/services/runner_service.rs:14-29,31-87,180-216`），repository 只保存命令、cwd、runtime kind、环境变量和端口（`cc-panes-core/src/repository/runner_repo.rs:19-69`），不是创建/销毁 VM 的 runtime。

### B2. 工作项系统集成

**结论：Orca 有 4 个真正任务源，`CONFIRMED_PRESENT`；CC-Panes 外部工作项集成 `CONFIRMED_ABSENT`。§6 应从 GitHub/Linear 扩展为 GitHub/GitLab/Linear/Jira，但不能写 7 个。**

Orca 的 `TaskProvider` 联合类型和常量只有 `github/gitlab/linear/jira`（`../references/orca/src/shared/task-providers.ts:1-8`）；TaskSourceContext 也只为这四种定义身份结构（`../references/orca/src/shared/task-source-context.ts:12-56`）。Azure DevOps、Bitbucket、Gitea 出现在 Forge/Hosted Review 层；Forge provider 分别声明 GitLab/GitHub/Bitbucket/Azure DevOps/Gitea 及 review creation 支持度（`../references/orca/src/main/source-control/forge-provider.ts:82-127,169-236`），不能算成任务源。

实际执行：

```bash
rg -n -i -e 'TaskProvider|GitHub issues|GitLab issues|Linear API|Jira API|Azure DevOps|work item provider|issue tracker integration|task source context' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果：零命中（9 个别名）。CC-Panes 的相邻 Todo 是本地 SQLite CRUD：服务生成 UUID、维护 scope/tags/due/recurrence/subtasks（`cc-panes-core/src/services/todo_service.rs:10-67,159-177`），repository 直接写 `todos` 表（`cc-panes-core/src/repository/todo_repo.rs:17-53`），没有外部 issue provider/client 同步链。

### B3. Hosted Review

**结论：Orca `CONFIRMED_PRESENT`；CC-Panes `CONFIRMED_ABSENT`。§6 漏记。**

Orca 对 GitHub/GitLab/Bitbucket/Azure DevOps/Gitea 建模统一 HostedReview，包含状态、URL、checks、mergeability、review decision、创建参数和错误码（`../references/orca/src/shared/hosted-review.ts:3-39,60-89`），并有认证、base/head、dirty tree、remote tracking 等创建 preflight（`../references/orca/src/main/source-control/hosted-review-creation.ts:35-95,138-207`）。Forge 层给 GitHub/GitLab/Azure/Gitea 提供 createReview，Bitbucket 当前只读（`../references/orca/src/main/source-control/forge-provider.ts:82-127,169-236`）。

实际执行：

```bash
rg -n -i -e 'HostedReview|PullRequestReview|MergeRequestReview|review creation|pull request comment|merge request comment|create pull request|create merge request' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果：零命中（8 个别名）。CC-Panes 相邻 Git 模块提供 repo discovery/status 等本地 Git 命令（`cc-panes-core/src/services/git_service.rs:21-95`），GitTimelinePanel 展示本地 branches/commits/files/diff（`web/components/GitTimelinePanel.tsx:61-90,248-299`）；未发现托管 PR/MR review 读取、批注、创建或队列。

### B4. Automations / External Automations

**结论：Orca `CONFIRMED_PRESENT`；CC-Panes `CONFIRMED_ABSENT`。§6 漏记。**

Orca Automation 模型包含 local/SSH target、scheduled/manual run、precheck、RRULE、missed-run grace、workspace reuse/new-per-run 和运行用量（`../references/orca/src/shared/automations-types.ts:4-18,32-35,71-125`）。服务每分钟 tick、支持 run-now、precheck、missed run 和 headless dispatch（`../references/orca/src/main/automations/service.ts:23-93,96-132,169-207`）。External Automation 还读取和管理本机/SSH 的 Hermes、OpenClaw jobs（`../references/orca/src/main/automations/external-manager.ts:162-215,226-319`）。

实际执行：

```bash
rg -n -i -e 'AutomationDefinition|AutomationSchedule|ExternalAutomation|missedRunGrace|headlessDispatch|scheduled automation|cron automation|RRULE automation' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果：零命中（8 个别名）。已读相邻的 Todo recurrence（`cc-panes-core/src/services/todo_service.rs:135-177`）和 Runner profile/instance lifecycle（`cc-panes-core/src/services/runner_service.rs:31-94,180-228`）；前者只生成下一个本地 Todo，后者只登记手工启动的进程，均没有 agent prompt scheduler、precheck、missed-run policy 或 external job manager。

### B5. Native Chat 与 Notebook

**结论：Orca 两项均 `CONFIRMED_PRESENT`；CC-Panes 两项均 `CONFIRMED_ABSENT`。§6 漏记。**

Native Chat：Orca 把 terminal agent 解析成原生 conversation/composer view，读取 session/transcript 并可切回 Terminal（`../references/orca/src/renderer/src/components/native-chat/NativeChatView.tsx:58-154`）；transport 对本机 IPC 和 remote runtime 提供统一 `readSession/subscribe`，并处理流重连（`../references/orca/src/renderer/src/components/native-chat/native-chat-session-transport.ts:15-68,235-260`）。

实际执行：

```bash
rg -n -i -e 'NativeChatView|nativeChat\.readSession|nativeChat\.subscribe|transcript renderer|transcript pagination|switch to terminal|agent transcript view|native conversation view' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果：零命中（8 个别名）。CC-Panes SelfChat 仍直接渲染 `TerminalView`（`web/components/selfchat/SelfChatManager.tsx:1-8,137-164`）。CCChan 的 structured output 来自它自己启动的独立 chat session 和专用 `ccchan-chat-output/status` 事件（`web/ccchan/ChatPanel.tsx:410-445,476-507`），不是任意终端 transcript 的分页/订阅 renderer。

Notebook：Orca 不只是文件预览。IPC 寻找本机 Python，构造受限执行代码、设 60 秒超时/2 MiB capture cap，并在 notebook 文件目录运行 cell（`../references/orca/src/main/ipc/notebook.ts:9-35,102-255`）；IpynbViewer 持有 cell 编辑、运行和 trust state（`../references/orca/src/renderer/src/components/editor/IpynbViewer.tsx:570-640,738-855`）。

实际执行：

```bash
rg -n -i -e '\.ipynb|Jupyter notebook|nbformat|notebook cell|runPythonCell|kernelName|cell outputs|notebook execution' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果：零命中（8 个别名）。CC-Panes EditorView 只把已知文本扩展映射到 Monaco，图片走 ImagePreview，Markdown 才有 preview/split（`web/components/editor/EditorView.tsx:14-75,300-322`），未发现 `.ipynb` model、cell/output UI 或 Python kernel/execution handler。

### B6. Telemetry / Observability / Crash Reporting

**结论：Orca 三项均 `CONFIRMED_PRESENT`；CC-Panes 对等管线 `CONFIRMED_ABSENT`。§6 漏记。**

Orca telemetry 在官方 build gate 后初始化 PostHog，带 install/session/common props、opt-out 和 consent/validator/burst-cap 顺序（`../references/orca/src/main/telemetry/client.ts:19-116,163-203`）。Observability 对 IPC、agent、Git、worktree、PTY 等定义 span wrapper，禁用时为 no-op（`../references/orca/src/main/observability/instrumentation.ts:1-24,173-184`）。Diagnostic bundle 走短期 token + 大小限制 + upload URL 校验后上传 NDJSON（`../references/orca/src/main/observability/diagnostic-bundle-upload.ts:37-95`）；CrashReportDialog 读取 pending/latest report、启动时一次性提示并支持 Help 打开（`../references/orca/src/renderer/src/components/crash-report/CrashReportDialog.tsx:16-78`）。

实际执行：

```bash
rg -n -i -e 'telemetry client|telemetry consent|analytics event|diagnostic bundle upload|observability tracer|crash report dialog|crash feedback|send diagnostic' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果：零命中（8 个别名）。CC-Panes 有本地 crash 记录：frontend ErrorBoundary 信息写本地 log 并返回 log directory（`web/utils/frontendCrashLog.ts:40-87`），Rust panic hook 也写 `crash.log`（`src-tauri/src/lib.rs:1201-1218`）。另有 terminal daemon bridge 内部名为 `BridgeTelemetry` 的本地重试统计，但它不是产品分析、trace/export、bundle upload 或 crash feedback UI。故不能把“有 crash.log/内部 telemetry 变量”高估成 Orca 的三件套。

### B7. 多账号与限流

**结论：Orca `CONFIRMED_PRESENT`；CC-Panes 对等能力 `CONFIRMED_ABSENT`。原 §6 已用“账号切换与用量追踪（含 Claude 周用量表）”覆盖，不另计订正。**

Orca Codex account service 支持 list/add/reauth/remove/select，并按 host/WSL target 隔离 managed home（`../references/orca/src/main/codex-accounts/service.ts:179-240,352-403`）；Claude account service 同样维护 active account 和 runtime selection（`../references/orca/src/main/claude-accounts/service.ts:334-395`）。RateLimitService 同时跟踪 Claude/Codex/Gemini/OpenCode/Kimi/Antigravity/MiniMax/Grok，维护 active/inactive account cache、定时刷新和账号切换窗口刷新（`../references/orca/src/main/rate-limits/service.ts:185-264,347-443`）。

实际执行：

```bash
rg -n -i -e 'ManagedAccount|activeClaudeManagedAccount|activeCodexManagedAccount|account switcher|OAuth account|weekly usage limit|rate limit window|usage reset time|Grok account' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果：零命中（9 个别名）。CC-Panes ProviderService 保存自定义 endpoint/credential provider、默认项，并在启动时生成 env（`cc-panes-core/src/services/provider_service.rs:130-213,241-270`）；UsageStatsService 每 300 秒扫描 Claude/Codex JSONL 并聚合 token/cost（`cc-panes-core/src/services/usage_stats_service.rs:18-26,352-438`）。这不等同于托管 OAuth 多账号、账号身份切换或 provider reset window/限流抓取。

### B8. Computer Use 与 Android Emulator

**结论：Orca 两项均 `CONFIRMED_PRESENT`；CC-Panes 对等能力 `CONFIRMED_ABSENT`。原 §6 已列，无需订正。**

Orca Linux computer-use sidecar 使用 AT-SPI 读取 desktop accessibility tree，带屏幕截图和敏感应用阻断（`../references/orca/native/computer-use-linux/runtime.py:1-75,649-724`）。Android backend 提供 device/AVD boot、tap/swipe/type/button/rotate/exec/install/launch/permission/accessibility/logcat（`../references/orca/src/main/emulator/backends/android-emulator-backend.ts:65-105,140-170,208-310`），stream controller 实际管理 scrcpy per-serial stream 生命周期（`../references/orca/src/main/emulator/android/android-stream-controller.ts:19-66`）。

实际执行：

```bash
rg -n -i -e 'computer.?use|screen.?control|desktop.?automation|mouse.?injection|keyboard.?injection|android.?emulator|adb.?device|emulator.?stream|screen.?scrape' web src-tauri cc-panes-core cc-panes-api cc-panes-web cc-panes-cli-hook cc-memory cc-memory-mcp cc-notify cc-cli-adapters
```

结果：零命中（9 个别名）。CC-Panes 的相邻能力不等价：ScreenshotService 只读取 cursor position 并截图（`src-tauri/src/services/screenshot_service.rs:16-32,71-99`）；BrowserService 可在应用内 WebView 通过 CDP `Runtime.evaluate/Page.captureScreenshot/Input.dispatchMouseEvent` 操作网页（`src-tauri/src/services/browser_service.rs:318-362`），但没有桌面 accessibility 操作、全局键鼠注入、ADB/AVD 或 scrcpy stream。

### B9. i18n

**结论：双方均 `CONFIRMED_PRESENT`。plan 要求确认 “Orca 有、CC-Panes 无” 与源码不符；当前 §6 并未把 i18n 列为 Orca 独有，因此无需订正 §6。**

CC-Panes 注册 zh-CN/en 两套 15 namespace 资源，默认中文并持久化切换（`web/i18n/index.ts:39-92`）。Orca 提供 en/zh/ko/ja/es，renderer 对非英文 catalog 懒加载（`../references/orca/src/renderer/src/i18n/supported-languages.ts:18-40`；`../references/orca/src/renderer/src/i18n/i18n.ts:17-85`）。这条不能判 CC-Panes ABSENT。

### B10. Pet / pet-bundle / custom-pet-file-reader

**结论：双方均 `CONFIRMED_PRESENT`。当前 §6 没有把 ccchan/pet 列为 CC-Panes 独有，无 §6 订正项；plan 对当前文档内容的描述不符。**

Orca 支持导入 `.codex-pet` 文件夹/manifest，对 `pet.json` 大小、symlink、路径逃逸进行检查并原子落盘（`../references/orca/src/main/ipc/pet.ts:238-290,381-409`）；底层文件读取限制大小、调用次数并防读时变更（`../references/orca/src/main/ipc/custom-pet-file-reader.ts:13-58`），agent `blocked/waiting/working/done` 驱动 waiting/running/review 动画（`../references/orca/src/renderer/src/components/pet/pet-agent-state.ts:40-90`）。

CC-Panes `PetMeta/PetDefinition` 包含 spritesheet/atlas/animations（`src-tauri/src/services/ccchan_service.rs:111-155`），加载内置 manifest 并合并用户 `data_dir/ccchan/pets/<folder>/pet.json`（`src-tauri/src/services/ccchan_service.rs:275-327`）；前端把 terminal status 聚合成 sad/waiting/thinking/working/idle（`web/ccchan/statusAggregator.ts:4-17`）。能力形态不同，但两边都不是“目录占位”。

## §6 需要订正的条目

共核验 **18 条**，其中 **11 条**需要订正当前 §6：

1. **resume 会话链**：从“CC-Panes 独有”移除；改为双方都有，并注明 Orca 有 AI Vault 多 agent resume 与休眠唤醒。
2. **Provider 多渠道热切换**：CC-Panes 当前只有凭证 CRUD、默认项和启动时选择；删除“热切换”或改成准确的启动期能力。Orca 托管账号切换不要未经运行时证据扩大为“已运行 CLI 热切换”。
3. **Dev/Release 隔离并行运行**：从“CC-Panes 独有”移除；Orca dev 也使用独立 userData namespace，普通 dev 还跳过单实例锁。
4. **OSC 双通道状态机**：从“Orca 无”改为双方有 hook + OSC；CC-Panes 是 OSC 777 + HTTP 跨通道去重，Orca 是 hook 主干 + OSC 9999 辅助。§4 的 “hook HTTP 单通道”也应同步订正。
5. **中文优先工作流深度**：不要写成 Orca 缺失。可改为限定性优势：CC-Panes 默认中文，中文 Markdown 文档覆盖 107/112；Orca 也有中文 UI，且共支持 5 种明确语言。
6. **ephemeral VM**：补入“Orca 有、CC-Panes 无”。
7. **工作项系统集成范围**：把现有 GitHub/Linear 扩展为真正的 4 个任务源 GitHub/GitLab/Linear/Jira；不要把 Azure DevOps/Bitbucket/Gitea 的 Forge/Hosted Review 适配算作任务源。
8. **Hosted Review**：补入“Orca 有、CC-Panes 无”，并可注明统一覆盖 GitHub/GitLab/Bitbucket/Azure DevOps/Gitea，创建支持度不完全相同。
9. **Automations / External Automations**：补入“Orca 有、CC-Panes 无”，包含 RRULE/cron、precheck、missed-run、local/SSH/headless 和 Hermes/OpenClaw 管理。
10. **Native Chat + Notebook**：补入“Orca 有、CC-Panes 无”；CC-Panes SelfChat/CCChan 不等价于任意 agent transcript renderer，Editor 也无 `.ipynb` cell execution。
11. **Telemetry / Observability / Crash Reporting**：补入“Orca 有、CC-Panes 无”；CC-Panes 本地 crash log 不等价于 consent telemetry、trace、diagnostic bundle upload 和 crash feedback UI。

不计入 11 条订正：多账号/限流、Computer Use、Android emulator 已被 §6 现有概括覆盖；i18n 和 pet 当前未被 §6 错列为单方独有。

## 我认为本 plan 有误或与实际不符的地方

1. **A 组标题本身不是事实**：resume、Dev/Release 隔离、OSC + hook 在 Orca 都存在；Provider “热切换”甚至在 CC-Panes 自身尚未落地。plan 的倾向性标注不能作为先验。
2. **“7 个工作项系统”混淆了两层能力**：真正 `TaskProvider` 只有 GitHub/GitLab/Linear/Jira 四个。Azure DevOps、Bitbucket、Gitea 属于 Forge/Hosted Review；其中 Bitbucket 还标记 `supportsReviewCreation: false`（`../references/orca/src/main/source-control/forge-provider.ts:169-171`）。
3. **B 组要求确认 i18n 在 CC-Panes 不存在是错误前提**：CC-Panes 有完整 zh-CN/en i18n，且默认中文（`web/i18n/index.ts:39-92`）。
4. **plan 称“§6 把 ccchan 列为独有”与当前文档不符**：当前 §6 的 CC-Panes 独有行是 `docs/43-orca-competitor-analysis.md:132`，其中没有 ccchan/pet。更重要的是，两边源码都实现了可定制 pet，不应再新增单方独有结论。
5. **`memory`、`cli/specs`、`ai-vault` 的目录名均不能作为功能证据**：本次独立追读确认，Orca `main/memory` 是 CPU/RSS/PTY 资源采样，`cli/specs` 是命令规格，而 `ai-vault` 才是跨 CLI session history/resume。这三个已知陷阱均已按实现重新判定。
