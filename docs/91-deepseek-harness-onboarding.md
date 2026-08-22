# 91 - DeepSeek Harness（dsh）接入

> DeepSeek 于 **2026-08-13** 开源 agent harness：`github.com/deepseek-ai/deepseek-harness`
> （MIT，默认分支 **`master`**，当天 23.8k stars），npm 包 `@deepseek-ai/dsh`。
> 官方标注 **developer preview，会有 breaking change**。
>
> 状态：批 1 已落地（托管进程 + 浏览器窗格 + 四项注入）。本文记录**实测事实**与
> 形态判决——凡带「实测」字样的结论都是跑出来的，不是读文档得来的。

## 0. 形态判决：它不是 CLI，也不该被当成 CLI 接

发布前的预案假设 dsh 是「PTY 里跑的 TUI」，照 `docs/21-grok-cli-support.md` 的路子新增一个
`CliTool` 变体。**这个假设错了**，整篇因此重写。

dsh 是 **profile 启动器**：`dsh --profile <name>` 引导一棵 cordis 插件树，随包只有两个 app bundle——
`web`（浏览器 UI，`127.0.0.1:3080`）与 `headless`（一次性任务）。**没有可在 PTY 里渲染的界面**，
所以它不是 `CliTool` 的第 N 个变体，而是「CC-Panes 托管的本地 Web 服务 + 浏览器窗格」这条独立形态。

### 0.1 TUI：他们做过，8-04 主动删了

这条容易被误判成「还没做」，实际是**做完又拆掉**——归档里有 **117 个 TUI 条目**
（banner 渐变、`/model` 带过滤的选择器、`/status` 详情、工具卡片折叠、文件引用补全、
Windows 支持、终端快照测试），是成品级前端。

删除决策 `.agents/notes/implemented/simplification/2026-08-04-remove-tui-package.md`：

> The `packages/ui/tui` package is **deleted without a compatibility package or alias**.
> Its source, package tests, terminal snapshots, dependency declarations, patched `pi-tui`
> artifact, workspace references... are removed together.

理由是唯一消费者只剩项目生成器，没有真实产品在用。他们还明确否决了「移到 examples 保留」：

> A future terminal frontend should **start from its actual host and interaction requirements
> rather than inherit this implementation by default**.

**所以「把它抽成 CLI」不成立**，三条堵死：①代码已删、无兼容包无别名；②它依赖一个
**打过补丁的 `pi-tui`**（仓库 `patches/` 下的定制版），不是普通 npm 包；③官方拒绝保留。

但删掉的**只是渲染层**。同一篇写明保留下来的能力：

> The provider-neutral **command, user-questions, approval, tool-presentation, PTY, and
> session-projection** capabilities remain available to other hosts.

并给出复活的四个条件：①具名产品或部署 ②明确的包边界 ③具体的 interaction provider
④完整的生命周期与 transcript 验收。**CC-Panes 恰好能满足前三条**——所以这条路是「写一个新
TUI 前端」而非「抽取」，工作量对标他们那 117 条的一部分。

**结论**：真要让 dsh 会话成为 CC-Panes 一等公民，走 SDK（§6）比重建 TUI 更直接——
自己画 UI，不受终端渲染限制。TUI 路线除非有别的理由，否则不划算。

## 1. 事实表（全部实测，非读文档）

| 项目 | 结论 |
|------|------|
| 安装 | `npm i -g @deepseek-ai/dsh`；**需 Node ≥20.19**（`chokidar@5` 要求），本机 20.17 装得上但跑不起来，用 24.12.0 |
| 二进制名 | `dsh`（纯 JS ESM）。Windows 上是 `.cmd` 批处理 shim，必须经 `which` 按 PATHEXT 解析 |
| 配置根 | `~/.dsh`，`$DSH_HOME` 覆盖（空串/纯空白视作未设） |
| 启动 | `dsh --profile web [--patch X] --port N`。**启动器 flag 必须在 app 子命令之前**——写成 `web --patch` 会报 `unknown option` |
| 端口 | `--port 0` 由 OS 分配，stdout 打一行 `dsh web: http://127.0.0.1:<port>`，回读即可（比自己扫端口稳，无竞态） |
| 启动耗时 | 冷启动 <10s（含 profile 首次初始化）；HTTP 200 响应 12ms |
| 资源 | 单实例常驻 **119 MB**，启动累计 CPU 4.8s |
| 绑定 | 只监听 `127.0.0.1`；`--host 0.0.0.0` **被 CLI 主动拒绝**（无鉴权层前不开放） |
| **注入点** | `--patch <path>` 可重复 overlay，**优先级最高**（bundle → profile → `$DSH_HOME` → `--patch`） |
| 持久化 | `storage-json` 整文件重写（见 §2 的硬约束）；`$DSH_HOME` 实测仅 169 KB，装 hooks 桥后 640 KB |
| RPC | `POST /api/<method>`，信封 `{"type":"client-request","rpcId":"..","method":"..","payload":{}}` |
| 前端嵌入 | **不可行**，见 §5 |

### 1.1 patch 语法（cordis loader）

两种形态，混淆会静默失效：

- **插新行**：`[{"insert": [ {...}, {...} ]}]`——不带 `id`，追加到根层。
- **改已有行**：`[{"id": "llm-pi-ai", "config": {...}}]`——带 `id`。对**不存在**的 id 只
  warn 后跳过（`patch: entry %C not found`），不报错。

给已存在的行用 insert 会造出两条同 id 的重复行；给不存在的行用改行语法则什么都不会发生。

内容可以直接写 **JSON**（YAML 是 JSON 超集，loader 照收）——省一个 YAML 序列化依赖，
也避开手写缩进/转义。

## 2. 硬约束：`$DSH_HOME` 的隔离粒度

**一个工作空间一个实例**，同工作空间的多个标签共享它。这个粒度是两条约束夹出来的：

**不能更粗**（比如全局一个）：dsh 的持久化走 `storage-json`，它自己的文档写死了语义——
「in-memory unit state is authoritative; every write primitive **republishes the whole file**」。
单写者模型、无跨进程锁。`rename()` 的原子性只保证不读到半个 JSON，**完全不防丢更新**。
实测两个实例共享同一个 `$DSH_HOME` **能同时启动、零报错、日志干净**——这是最坏形态：
A 建的工作空间会被 B 的下一次写整份抹掉，没有任何信号。

**不能更细**（每标签一个）：用户填的 API key 存在 `$DSH_HOME/.credentials.yaml`，工作区注册与
会话历史也都在 `$DSH_HOME` 下。每标签一份 = **每开一个新标签都要重填一次 key、重选一次工作区，
历史还各看各的**（0.12.5 期实测踩到，用户直接反馈「每次启动都会忘记 key」）。

实现落点 `cc-panes-core/src/services/dsh_service/`：
- 实例键 = 工作空间路径的归一化哈希。归一化顺序要紧：**先统一分隔符、再削尾斜杠、最后小写**，
  顺序错了 `D:\x\cc-book` 与 `d:/x/cc-book/` 会算出两个键，同一工作空间被劈成两个实例。
- **引用计数停止**：`stop` 只在最后一个标签释放时真停进程，否则关一个标签会把同工作空间
  另一个标签的画面掐掉。
- 无工作空间的标签共用一个 `default` 实例，不是各开各的。

⚠️ **改任何影响归属粒度的逻辑前，先问：用户已经存在那个 `$DSH_HOME` 里的东西会不会跟着搬家？**
凭据（`.credentials.yaml`）、工作区注册、会话历史都在里面。0.12.5 修完 cwd 继承后
`workspace_path` 才真正生效，隔离从「全挤在 default」变成按工作空间分家——隔离是对的，
但用户先前在 dsh UI 里填的 API key 留在了 `default/`，新工作空间开出来是空的（详见 §8.2）。

## 3. 四项注入（全部经 `--patch`，不改 dsh 一行代码）

| 注入 | 行 | 关键点 |
|------|----|--------|
| MCP | insert `@deepseek-ai/dsh-mcp-client` | `transport: streamable-http` + 本次 launchId/token 的 URL。工具名 `mcp__ccpanes__*`，与 Claude/Codex 同构。**HMR 热插拔**，改配置不重启 |
| Skills | insert `@deepseek-ai/dsh-skill-filesystem` | `customSkillDirs`（rank 300）指向已物化的 `<data>/skills/builtin`。**`includeDefaultRoots: false`**——不扫用户项目里的 `.dsh`/`.agents`，否则「CC-Panes 注入了哪些 skill」不可解释。格式同为 `SKILL.md`，零转换 |
| Hooks | insert `@deepseek-ai/dsh-hooks-claude-code` | 见 §3.1 |
| Provider | **改** `llm-pi-ai` 行 | 见 §3.2 |

### 3.1 Hooks：官方 CC 方言桥，但有个致命前提

`@deepseek-ai/dsh-hooks-claude-code` 能直接跑 Claude Code 形状的 `hooks.json`，连
`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` 替换和 10 分钟默认超时都照搬。

**11 个 `HOOK_DEFS` 里只有 6 个能过桥**：

| 可过桥 | 不支持（桥无此映射，warning 跳过） |
|--------|------------------------------------|
| `SessionStart`×2 / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` | `PreCompact` / `Notification` / `StopFailure` / `SessionEnd` / `PermissionRequest` |

掉队的 5 个全是状态机驱动那批。对 dsh 影响有限——它跑在浏览器窗格里，本来就不进我们的
终端状态机（没有 PTY、没有 OSC）。**只生成能过桥的那 6 个**：一个永远不触发的 hook 躺在
配置里，比它不存在更难排查。

**致命前提（实测踩到）**：hooks 桥**不在 dsh 的依赖里**。dsh 只把 `dsh-mcp-client` 打进
依赖（文档明说），桥要单独装。缺包时**整个进程起不来**（`ERR_MODULE_NOT_FOUND`），
不是「hook 不生效」那么轻。

而且 `dsh plugin add` **不自动装 peer**——它声明 9 个 peer，其中 `dsh-hook-protocol` 是
import 时必需的，缺了同样崩。**两个包都要探测、都要装**。

版本代际还对不齐：实测桥 `0.0.1-rc.5`、protocol 解析到 `0.0.1-rc.1`、本体 `0.1.0-rc.6`。
在一个每天发数版的 preview 上这个组合随时可能裂——所以自动装**必须允许失败**，
失败时摘掉 hooks 行继续启动（丢一个 hook 远好过标签完全打不开）。

### 3.2 Provider：改行不写文件，且密钥只走 env

dsh 的模型路由是 `llm-pi-ai` 插件，配置形状 `llm-pi-ai.providers.<route>`。

**两条它自己定死的规矩**：
1. **配置只存凭据引用不存密钥**（`apiKeyEnv: FOO_API_KEY`）。我们因此把 key 走**进程 env**
   注入——那是 dsh 凭据层级里优先级最高的一层，用户在 CC-Panes 配一次所有标签生效。
   副作用是 dsh 自己的 Models 页会把该项显示为只读（`source: 'env', writable: false`），
   这正是我们要的：Provider 主权归 CC-Panes。
2. **手工声明的路由必须列全 `models`**。没有模型的 Provider 不生成路由——空路由只会让请求
   以 `UNKNOWN_MODEL` 失败。同理跳过原生鉴权类（Bedrock 要 AWS 凭据、Vertex 要 ADC、
   ConfigProfile 无端点），硬塞 apiKey 路由等于造一个必然失败的配置。

**不要写 `settings.yaml`**（实测踩到）：它是 **dsh 自己的可读写状态文件**（实测它往里写
`ui-onboarding.welcomeNoticeVersion`）。整份覆盖会让**用户在 dsh UI 里改的设置下次开标签就消失**。
Provider 因此走 patch 的 `llm-pi-ai` 行——patch 文件完全归我们，settings 完全归它，边界干净。
回归测试 `launch_materials_never_touch_the_settings_file` 守这条。

## 4. 工作空间同步

dsh 的输入框在选定工作区之前是禁用的（占位文案「选择一个工作区开始」）。用户在 CC-Panes 里
已经维护了项目清单，没理由再手动添一遍。

`POST /api/workspace.create` 可从外部调（实测通过），对同一路径**幂等**
（「creates at most one record per canonical path」），所以每次实例启动都推一遍是安全的。

实现在命令层 `src-tauri/src/commands/dsh_workspace_sync.rs`（service 只管起进程，
「推什么」属于装配，且 reqwest 只在这一层）。**尽力而为**：失败只记日志——推送失败的后果是
用户自己点一下选择工作区，做成硬失败会让整个标签打不开。跳过归档项目（`archivedAt` 是逻辑
删除标记，推过去等于在 dsh 侧复活）与不存在的目录。

配套可用：`workspace.list` / `setTitle` / `attachSession` / `archiveSession` /
`session.create` / `session.prompt` / `host.describe`。

**注入范围是「全部工作空间的活跃项目」，不是当前那一个**（0.12.5 改）。用户的心智模型是
「CC-Panes 里维护好的项目就该在这儿」，只推当前工作空间会让另外十几个项目永远手工添加。
附带的好处是**不再依赖 `workspace_path`**——那个字段前端常常传不下来（旧标签没快照、
选中态取不到），一旦为 None，按工作空间过滤就退化成「一个都不推」，功能整个静默失效。
三条过滤规矩写在 `all_active_project_paths`：归档不推、路径判定必须过 `classify_path`
（不能裸 `Path::exists()`，注册路径可能是 `/mnt/...` 或 `\\wsl.localhost\...` 形式）、
**`Unverifiable` 一律保留**（它表示「现在看不到」而非「不存在」——SSH 项目、WSL 发行版
没运行都是这个值，丢掉会让用户的远程项目莫名其妙不见且零报错）。

## 4.5 leader/worker 回执：让 codex 能「说」回 dsh

dsh 单向驱动终端 worker 一直是通的（`launch_task` → `submit_to_session` →
`wait_for_session` → `get_session_output`）。**反向不通**，因为既有回执协议
（`report_to_leader`）的投递链三处硬耦合 PTY：leader 必须有 `session_id`、该 id 必须能在
`TerminalBackend::get_session_status` 查到（dsh 是 web 进程必然查不到 → skip
"leader session not found"）、投递写死为往 PTY 粘贴文本。

**dsh 是 web UI 不是障碍，反而给了最好的投递口**：`session.prompt` 与它 UI 输入框走同一条
代码路径（`createUserMessage`），官方注释明说「the method stays callable regardless」——
输入框禁用只是 UI 表象。它不在 `PRIVILEGED_METHODS` 里，Rust 侧 reqwest 从 loopback 调用
不带 Origin 即过 fence，与 `workspace.create` 完全同一条已验证通路。

落点：
- **身份**：`register_plan_leader` 新增 `leaderKind: "dsh"`。MCP 调用不携带 dsh 会话身份
  （mcp-client 是实例级的，`resolve_caller_session_id` 只认 `?launchId=` 而 dsh 解析不出），
  但 **agent 只有在跑轮次时才可能调工具**——调用发生的那一刻，调用者的会话必然
  `running: true`。服务端当场查 `session.list` 挑出它，编成 `dsh:<workspaceKey>:<sessionId>`
  存进 leader 的 `session_id`（前缀避免与 PTY id 域冲突）。
- **投递**：`send_worker_report_to_leader` 在 PTY 状态检查**之前**按 `dsh:` 前缀分流，走
  `session.prompt`（`mode: "queue"`——dsh 忙时在**它自己侧**排队，因此不需要复用 orchestrator
  那套按 PTY session_id 编键、靠 `SessionStateMachine` 事件驱动的排队机，dsh 永远没有那个事件源）。
  端口每次投递**实时解析不缓存**（每次启动都变）。
- **降级**：实例没在跑就诚实丢弃 + worker metadata 记 `reportDropped`（与队列 TTL 过期同口径）。
  **不做 orchestrator 侧持久队列**——补投需要 dsh 生命周期事件源，另立批次。
- **引导**：default-skill `dsh-orchestrate-worker.md`（dsh 的 agent 不会自己发现这套协议）。

效果：codex 完成后调 `report_to_leader`，回执**以用户消息形式出现在 dsh 的聊天界面里**，
用户看得见，dsh 的 agent 被触发跑一轮、可以继续追问 worker——真正的双向对话。

## 5. 为什么不嵌入前端

技术上有口子：入口是 `new AppWebEntry(el, seams?)`，只要一个 mount 元素，`seams` 参数
就是给「external `<script>` execution cannot reach the page context」（即 CSP 受限环境）留的。

**但不划算，且卡在一道安全设计上**：

- `/api` 的 **browser-trust fence**：「an attached `Origin` must equal the Host authority,
  and an explicit `sec-fetch-site: cross-site` marker is **refused**」。Tauri 主窗口 origin 是
  `tauri.localhost`，跨源 fetch `127.0.0.1:<port>` → **403，在任何 RPC 派发之前**
  （实测确认）。这是 DNS-rebinding 防御，`--trusted-host` 救不了（它还要求 Origin 等于 Host）。
- 它不是组件库是**自带内核的运行时**：靠 `window.__DSH_BOOT__` 往页面塞 external classic
  script、`window.__ModuleLoader__` 全局注册、CSS 在各 factory 闭包里自注入。嵌它 = 让出页面级主权。
- React 版本对不上（它 18.2，我们 19）。
- **省不掉后端进程**：plugin bundle 由 server 的 `/plugins` 提供，数据走 `/api` + 两条下行 WS。

**收益却≈浏览器窗格**：嵌完画面依然是它的 UI，会话依然不在我们 pane 树里。付最高成本
（拆别人的安全围栏 + 双 React + CSS 隔离）换同样的东西。

反过来，**webview 导航到 `http://127.0.0.1:<port>` 天然过 fence**（origin 即 loopback），
不需要反代、不需要 `--trusted-host`。这就是批 1 的做法。

他们自己的桌面方案（README 提到 Electron 走 `file://` + IPC bridge 的 in-process carrier）
要求 client 与 host 在**同一个 Node 进程**——Tauri 后端是 Rust，复刻不了。

## 5.5 插件生态：在哪找、怎么装

开源当天生态就起来了——`dsh-plugin` topic 下 **642 个仓库**（2026-08-14 实测）。

### 入口

| 渠道 | 地址 | 说明 |
|------|------|------|
| 官方 topic | `github.com/topics/dsh-plugin` | 一手源，根 README 明说打这个 topic 以便被发现 |
| 社区目录 | `AdamPlatin123/awesome-dsh-plugins` ★292 | 带**每日兼容性追踪**——preview 期上游天天 breaking，这个比星数有用 |
| 社区目录 | `0xsline/awesome-deepseek-harness` ★133 | 汇总自 topic + `dsh-external/hub` |
| 脚手架 | `npm create dsh-plugin` | 写自己的插件用（批 2 可直接起架子） |

**`dsh-external` 是受限组织**：2026-06-19 建（早于开源日近两个月），`public_repos` 显示 0，
但下属仓库**逐个公开**——`dsh-external/dsh-toolkit`（★13）、`dsh-deepresearch` 可读，
而 `hub`、`issues` 均 404。awesome 列表自己标注「some `dsh-external` repository links may
still require org access」。**结论：那是个半官方的策展组织，目录本身不公开，别把它当权威索引**，
以 topic 为准。

### 安装与激活

```sh
dsh plugin --profile web add <npm 包 | github:owner/repo#ref | file: | link:>
```

转发给 pnpm，所以 npm / Git / 本地路径 / `file:` / `link:` 都支持。装完**要重启**
`dsh --profile web`。管理面板在 Settings → Plugins。

**激活的唯一判据是 `package.json` 里的 `dsh.bundle.patch`**：

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

声明了才成为 profile 层；没有则「installed as a plain dependency, **not a profile layer**」——
装着但不生效。我们的 hooks 桥正是这种（无 `dsh.bundle`），所以它只能靠 `--patch` 手动挂行，
不能指望 `dsh plugin add` 之后自动起作用。

两个安装期的坑（实测）：**peer 依赖不自动装**（见 §3.1）；git 源插件首次 add 会被 pnpm 的
`allowBuilds` 拦一下，按提示把 key 抄进 profile 的 `pnpm-workspace.yaml` 再跑。

### 三个与我们直接相关的

- **`PerryLink/dsh-claude-move`** —— 把 Claude Code 的会话、记忆、skills、CLAUDE.md 迁进 dsh
  并支持 resume。与我们的 skills 注入同一问题域，格式映射可参考。
- **`PerryLink/dsh-permission-rules`** —— Claude Code 风格声明式权限规则，跑在
  `tools/pre-execute` waterfall 上。
- **`csiroqa/dsh-plugin-usage-report`** —— 用量报表（按日/月聚合 token 与费用）。

后两个共同印证一件事：**dsh 原生插件能做的比 CC 兼容桥多**。权限规则与用量统计恰好是我们
hooks 桥掉队的 5 个事件、以及「用量统计对 dsh 会话不生效」这两个已知边界所对应的能力，
它们用原生插件都做到了。对批 2（写 CC-Panes 的 dsh 插件）这是好消息——**不必受限于那 6 个
可过桥事件**，原生扩展点（`tools/pre-execute` 等）是完整的。

## 6. 未排期：SDK 驱动的原生窗格

把 dsh 会话变成 CC-Panes 一等公民的唯一实际路径（比重建 TUI 划算，见 §0.1）：
`packages/sdk` 的 stdio NDJSON JSON-RPC（`dsh-sdk-jsonrpc-server`），`session.event`
（每条 durable fact）+ `session.status`（整 agent 生命周期）全流式出来，我们自己画 UI。
会话可进 pane 树、进布局快照、被 MCP 编排。

**ACP 排除**：`packages/acp` 自称 automation-only，「does not expose editor navigation,
transcript replay, commands, modes... reasoning, plans, titles, or tool presentation」，
只给 committed 文本——做 UI 不够用。

**现在不做的理由**：dsh 是 developer preview 且官方标注会有 breaking change，此时锁定 wire
协议，改一次上游我们跟一次。注意 `boundary_events.rs` 的穷举守卫——新增跨 daemon 事件必须
先改契约表，否则会掉进 emitter 的 `_ => {}`（docs/45 那类静默失效）。

## 7. 批 1 已落地清单

**新建**
- `cc-panes-core/src/models/dsh.rs` — `DshInstance` / `DshLaunchSpec`
- `cc-panes-core/src/services/dsh_service/{mod,provider_mapping,hooks}.rs` — 托管 + 三类注入生成
- `src-tauri/src/commands/{dsh_commands,dsh_workspace_sync}.rs`
- `web/services/dshService.ts`、`web/components/panes/DshTabContent.tsx`

**修改**：`contentType: "dsh"`（归 terminal 组，Bot 图标）+ `tabContentType.ts` 两张表 +
`tabLifecycle/registry.ts` 登记（`onClosed` 停进程 + 关 webview）+ `NewTabMenu` 入口 +
`browserTabActions.openDsh`；`cc-cli-adapters` 的 `build_guarded_hook_command` 由
`pub(crate)` 开放为 `pub`（hook 命令形态必须单点维护）。

**明确不做**：布局快照恢复、`launch_task` 编排、用量统计对 dsh 会话都**不生效**——
它的会话活在自己的进程里，我们只托管进程不托管会话。这是批 1 的已知边界，别当成 bug。

### 7.1 批 2（0.12.5）：双向对话 + 三个真机缺陷

- `resolve_launch_cwd`（`dsh_service/mod.rs`）—— 绝不继承宿主 cwd，见 §8.1③
- `all_active_project_paths`（`dsh_commands.rs`）—— 工作区注入改为全部工作空间，见 §4
- dsh leader 回执链（`dsh_workspace_sync.rs` 的 `list_sessions`/`pick_running_session`/
  `prompt_session` + `orchestrator_service.rs` 的 `DSH_LEADER_PREFIX` 分流）—— 见 §4.5
- default-skill `dsh-orchestrate-worker.md`
- `BrowserTabContent` 的 URL 重导航 + `cleanRehydratedPanes` 清 dsh 陈旧 URL —— 见 §8.3
- 顺带：`SessionStatus` 全变体加 `#[serde(alias)]` 容忍 PascalCase。`wait_for_session` 的
  `waitFor` 在 schema 里是 `Vec<String>`（`#[schemars(with = ...)]` 遮掉了枚举取值），
  客户端只能从工具描述猜大小写——**实测两个不同的 agent（Claude 与 dsh）第一次都发了
  `"Idle"` 并吃了 unknown variant**。描述也补上了完整的合法值列表。

**尚未真机验证**（dev 停在编译完成、用户未跑端到端）：leader/worker 回执的完整链路。
判定标准：codex 完成后 `[worker-report] ...` 应作为一条用户消息出现在 dsh 聊天界面里，
日志里有 `worker report delivered to dsh leader session`。

## 8. 踩过的坑（真机才暴露）

1. **`State<'_, AppPaths>` 与 manage 的 `Arc<AppPaths>` 不匹配**：`cargo check` 照样过——
   Tauri 的 State 解析在**运行时**，只有真点一次才报 `state not managed for field`。
   仓库既有 4 处全用 `Arc<AppPaths>`，照抄即可。
2. **整份覆盖了 dsh 的 `settings.yaml`**（见 §3.2）。当时没炸只是因为恰好没有可映射的
   Provider，属于「侥幸没触发」的真缺陷。
3. **`--patch` 位置写反**（见 §1 启动行）。

### 8.1 「一打开 DSH 标签，dev 就闪退重启」——四层误导叠一起

0.12.5 期实测，排查绕了整晚，四层每一层都足以单独把人带沟里。**按发现顺序倒着记，
因为最外层的误导最贵**：

**① 日志里的 `build.rs changed` 是纯粹的排序副作用，与 build.rs 无关。**
tauri-cli 的 watcher 收到一批事件后用 `paths.first()` 挑一个名字打日志
（`interface/rust.rs:580`）。实测一次触发是 **415 个事件覆盖 `src-tauri` 整棵树**，按目录
遍历顺序排列，`build.rs` 恰好是第一个条目。所以日志点名的文件**通常不是元凶**——
它的 mtime 停在两周前，从没被改过。历史上那几次 `skill_market_service.rs`、
`erDiagram-*.js` 也是同一现象在不同批次的产物。**判定：先看事件总量**，成百上千条
= 全树风暴，此时日志里那个文件名毫无信息量。

**② 不是崩溃，crash.log 会告诉你。** `~/.cc-panes-dev/crash.log` 由 panic hook 写
（`lib.rs:1377`）。它没有新记录 = 没有 panic，那是 tauri-cli 自己 `child.kill()` 后重建
（`rust.rs:593`）。**Windows 事件日志与 WER 是操作系统的日志，不是我们的**——只查它们
就断言「不是崩溃」是不充分的，要查我们自己写的那份。这条本该是排查第一步，实际绕到很后面
才想起来。

**③ 真凶：`dsh_service` 静默继承宿主 cwd。** dsh 把调用目录当默认工作空间根，而
`tauri dev` 是从 `src-tauri/` 执行 `cargo run` 的——`project_dir` 与 `workspace_path`
都为 None 时旧代码什么都不做（**连 warn 都没有**），dsh 于是把 `src-tauri` 当成工作区根
去遍历，正好是 watcher 的地盘。修法是 `resolve_launch_cwd`：project_dir → workspace_path
→ `$DSH_HOME` 三级兜底，**任何路径都不继承宿主 cwd**，降级必须打 warn。
与 `spawn_pty` 对无效 cwd 静默回退 HOME（docs/46）是同一类坑：**静默落到一个「看着合理」
的目录，进程在错误的地方干活且无人察觉**。回归守卫 `launch_cwd_never_inherits_host_cwd`
显式断言 `cwd != current_dir()`。

**④ 排查工具本身会骗人。** 用 PowerShell 的 `FileSystemWatcher` + `Register-ObjectEvent`
做外部观测时，事件处理器**在主脚本 `Start-Sleep` 期间不投递**，时间戳记的是刷新时刻而非
事件时刻（实测写入 23:53:32、日志记成 23:54:20，差了整个心跳周期），大批量事件还会撑爆
内部缓冲被静默丢弃。据此得出的「触发时刻零事件」是假象。**做外部观测装置前必须先做阳性
对照**（对已知写入验证各通道都能触发），否则拿到的负面结论全部无效。

**方法论教训**：CC-Panes 自己日志打得很细，`dsh instance started` 那行就在风暴前 3 秒。
应该先用我们自己的日志锁定「谁在动作」，再用外部工具验证机制——反过来做（先搭外部观测
去重建一个内部有日志的系统的行为）代价极高，中途还产出过三个后来自证推翻的结论。

### 8.2 改实例归属粒度 = 带走用户已配置的凭据

修完 ⑧.1③ 之后 `workspace_path` 真正生效，工作空间隔离从「全挤在 `default`」变成按
工作空间分家——**正确，但用户在 dsh UI 里填的 API key 存在 `$DSH_HOME/.credentials.yaml`，
跟着旧家留在了 `default/`**，新工作空间开出来是空的，表现为「配好的密钥不见了」。

§3.2 那条「配一次所有标签生效」的保证**只覆盖 CC-Panes 侧配置的 Provider**（走 `spec.env`，
进程环境是 dsh 凭据层级最高优先级），**不覆盖用户在 dsh 自己 UI 里填的**。两者是不同的
存储位置，隔离粒度一变，后者就走丢。

**改任何影响 `$DSH_HOME` 归属的逻辑前，先问：用户已经存在那里的东西会不会跟着搬家？**
根治方向是引导用户在 CC-Panes 的 Provider 设置里配（DeepSeek 选 **OpenAI 类型**，映射成
`openai-completions`），这样走 env 注入、跨工作空间自动生效。注意 §3.2 那条：
**模型列表为空的 Provider 静默不生成路由**，表现成「配了没用」。

### 8.3 dsh 标签的 URL 跨重启必然失效，而 webview 不会自己改道

dsh 的 URL 是 `--port 0` 由 OS 现分配的端口，**存进布局快照后跨重启 100% 是死的**。
两个独立缺陷叠出「重启后 DSH 标签变成 `ERR_CONNECTION_REFUSED` 的浏览器页」：

1. `BrowserTabContent` 的创建 effect 首句 `if (... || createdRef.current) return`——
   **一旦创建过就永久短路**。`tab.browserUrl` 虽在依赖数组里、effect 也确实重跑，但进不去
   函数体，新端口永远送不到 webview。普通浏览器标签没事（URL 变化走地址栏 `navigate()`），
   但 dsh 的 URL 是被外部换掉的，**没有任何人会去调 navigate**。
   修法：记 `loadedUrlRef`（webview 实际加载的 URL），「已创建**且 URL 没变**」才跳过；
   后端 `browser_service.rs::create` 本就对已存在的 webview 转成 navigate + setBounds
   + setVisible，前端只是没让它跑到那儿。
   **配套不变式**：`onPageLoad` 与地址栏 `navigate()` 都要同步 `loadedUrlRef`——前者回填的
   URL 带尾斜杠，不同步会与外部 URL 反复失配成**无限重建**；且用户点链接导航会被误判成
   「外部换了 URL」而弹回原页。收敛成一句：**只有 URL 被外部换掉才重导航**。
2. 快照恢复不该留着那个死 URL。`cleanRehydratedPanes` 对 `contentType === "dsh"` 清空
   `browserUrl`，直接落到 `DshTabContent` 的「正在启动」态，连那一下错误页闪烁都没有。
   **普通 browser 标签的 URL 不能一起清**（那是用户的真实目标），测试
   `applyLayoutSnapshotPayload 清掉 dsh 标签的陈旧 URL，但保留普通 browser 的` 守这条。

另注：`createTab()` 是**终端专用**构造器（内部写死 `createTabOfType("terminal", ...)`），
传 `contentType: "dsh"` 不生效——测试里构造非终端标签要写字面量，否则断言的是一个
contentType 被悄悄改成 terminal 的对象。

### 8.4 别在用户实测 dev 时改被监视的源文件

本轮实测过一次：用户正在 dsh 里对话，我同时在编辑 `dsh_commands.rs` 并跑 `cargo check`，
**每存一次盘 watcher 就杀掉他的 app 重建一次**（4 分钟内 4 次）。用户看到的是「调用 MCP
后闪退」，与 MCP 毫无关系。改 `src-tauri/` 或任何 workspace crate 都会重启对方的 app；
改 `web/` 只触发 HMR（轻，但仍可能扰动 webview 型窗格）。**开工前先确认对方不在测。**

另有一条与 dsh 无关但同批踩到：往 Rust 源码里用 heredoc 写 Windows 路径字面量，
`\04` 被 Python 当八进制转义写成 `\x04`（记忆里已有「heredoc 中文脚本会碎」，
反斜杠是同一类）——批量改源码一律 Write 成 `.py` 再执行。

## 9. 前置解耦（发布前已完成，接入时无需再碰）

| 解耦项 | 现状 |
|--------|------|
| launch_task 准入 | adapter 声明 `supports_orchestrated_launch`（默认 false） |
| string→enum | 唯一入口 `CliTool::from_id` + `CliTool::ALL` + 往返测试 |
| 前端四张表 | `KNOWN_CLI_TOOLS` 运行时清单 + `cliToolCoverage.test.ts` 穷举守卫 |
| daemon 陈旧 | `DAEMON_BINARY_STALE` + 修复指引 |

注：这四项是为「新增 `CliTool` 变体」准备的。dsh 走的不是那条路（§0），所以本次**一项都没用上**——
但它们对下一个真·CLI 形态的 harness 仍然有效。
