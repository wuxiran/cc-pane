# 110 · 全 CLI 的 MCP / Skills 适配计划

> 状态：批 0–4 已在 feat/mcp-skills-parity 落地（2026-11-21）；批 5 进行中。
> 依据：代码现状盘点（本文 §2，带 file:line）+ 11 个 CLI 官方文档调研（§3，带来源）。
> 相关：docs/97（技能市场与投递）、docs/103（ccpanes MCP 瘦身）、docs/104（pi/omp/jcode MCP，§5/§7 有 WSL 与隔离 backlog）、docs/101（插件系统草案）。

## 1. 一句话结论

**11 个 CLI 全都原生支持 MCP，也全都读 `SKILL.md` 目录形态的 skills**，但 CC-Panes 只把 Claude 和 Codex 接完整了。其余 9 家要么完全没接，要么接了一半且 UI 显示「可用」。

问题主要不在「某个 CLI 不支持」，而在三处：
- **能力判断散落在 7 张表里**：后端能力位、`remote_mcp_supported`、`MCP_UNSUPPORTED_CLIS`、`TOOL_MCP_HINT_KEYS`、`launchMenu.supportsSsh`、`EXTERNAL_SKILL_GROUPS`、`PROJECT_SKILL_ROOTS`。
- **`skill_mount_paths` 传给了所有 adapter，只有 Claude 和 Codex 读**。
- **WSL 绕过 adapter**，自己拼命令，并固定 `skip_mcp:true`。

本计划先建一个单一的能力模型，并加一个守卫测试：声明了支持，就必须在实际启动命令里看得到。在这个前提下逐家补齐。

## 2. 现状（代码盘点）

### 2.1 MCP

| CLI | ccpanes 自身 | 共享 MCP | 工作空间层 | 隔离 | 调用方身份 | WSL | SSH |
|---|---|---|---|---|---|---|---|
| claude | ✅ 每会话文件 + `--mcp-config` | ✅ 含 headers | ✅ | ⚠ 合并 `~/.claude.json` 不过滤，无 `--strict-mcp-config`（claude.rs:331-355） | ✅ | ✅ | ❌ |
| codex | ✅ `-c mcp_servers.*` | ✅ http（无 SSE） | ✅ | ✅ 显式 disabled（codex.rs:1382） | ✅ | ✅ | ❌ |
| opencode | ✅ `OPENCODE_CONFIG` 每会话文件 | ⚠ 不带 headers | ❌ | ❌ 忽略 disable_unlisted | ✅ | ❌ | ❌ |
| cursor | ⚠ 写**用户级** `~/.cursor/mcp.json`，持久，并发会话 launchId 互相覆盖 | ⚠ 持久残留 | ❌ | ❌ | ⚠ | ❌ | ❌ |
| grok | ⚠ 写**用户级** `config.toml`，不带 launchId | ⚠ 持久残留 | ❌ | ❌ 只 warn | ❌ | ⚠ 只 ccpanes | ❌ |
| pi | ✅ 扩展桥 + 每会话文件 | ✅ | ✅ | ⚠ 只 warn | ❌ | ❌ | ❌ |
| omp | ⚠ 项目级 `.omp/mcp.json`，并发后写覆盖 | ✅ | ✅ | ⚠ 只 warn | ❌ | ❌ | ❌ |
| jcode | ⚠ 只能经 ctl stdio 代理 | ⚠ 只认 stdio（terminal_service.rs:291） | ⚠ 跳过 http | ⚠ 只 warn | ❌ | ❌ | ❌ |
| gemini / kimi / antigravity | ❌ `supports_mcp=false` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

其他已知问题：
- 启动档 `include_ccpanes_mcp=false` 会被整体当成 `skip_mcp`（launch_profile_service.rs:324），连共享和工作空间层的 MCP 一起关掉。
- WSL 下给非 claude/codex 的 context 固定 `skip_mcp:true`（wsl_codex.rs:2156）。
- 前端对所有 CLI 一律显示 WSL「partial」（launchInjectionSummary.ts:43）。

### 2.2 Skills

| CLI | 投递模式 | 内置 skill | 工作空间技能 | 启动档用户技能 | 备注 |
|---|---|---|---|---|---|
| claude | Native + Prompt | ✅ `--plugin-dir` | ✅ `--plugin-dir` | ✅ | |
| codex | Native + Prompt | ✅ `-c skills.config` | ✅ | ✅ | WSL 下内置技能**拷贝进** guest 的 `~/.codex/skills`（会污染用户目录） |
| opencode | Prompt | ⚠ 只内联 10 个 portable 技能 | ✅ 提示块 | ✅ | WSL 下提示词丢失 |
| grok | Prompt | ⚠ 内联到 `--rules` | ✅ | ✅ | |
| pi / omp | PiSkill | ⚠ 仅托管 Provider 模式，且只有 1 个 | ❌ | ✅ | PiSkill 压掉了提示词回退 |
| jcode | NativeSkill（推导） | ❌ 没人写 `~/.jcode/skills` | ❌ | ❌ | **UI 显示「可用」，实际什么都收不到** |
| cursor / gemini / kimi / antigravity | 空 | ❌ | ❌ | ❌ | docs/97:88 说 Cursor 和 Gemini 走提示词注入，与代码不符 |

其他已知问题：
- `resolve_skill_compatibility` 只要投递模式不为空就报可用（launch_profile_service.rs:1238）。
- 依赖 `sidecar_resource_dir` 的提示词和 Pi skill 注入，在 daemon 进程里可能拿到 None（terminal_service.rs:2823），**待实测**。
- `PROJECT_SKILL_ROOTS` 只覆盖 4 个 CLI；项目 Skill 管理界面已在 #100 下线。

### 2.3 批 0 已落地（5e6218bb）

- `InjectionProfile` 单源 + 诚实守卫 `cc-cli-adapters/tests/injection_profile_honesty.rs`；11 个 adapter 显式给出真实值（`web/test/cliToolCoverage.test.ts` 断言每个 adapter 文件都实现了 `fn injection_profile`）。
- 后端 `remote_mcp_supported`、ctl 代理白名单、提示词回退、`resolve_skill_compatibility` 改读描述；`include_ccpanes_mcp` 与 `skip_mcp` 拆开。
- 前端：`get_cli_injection_profiles` 由 `web/stores/useCliInjectionProfilesStore.ts` 在启动时拉一次（失败 / web / 测试用静态兜底 `web/lib/cliInjectionProfiles.json`）；§1 的散表已删：`MCP_UNSUPPORTED_CLIS`、`remoteUnsupportedByProfile` 的 CLI 名单、`TOOL_MCP_HINT_KEYS`（改为按描述生成提示）、`EXTERNAL_SKILL_GROUPS.applicableTools`（→ `skills.nativeSources`）、`launchMenu.supportsSsh`（→ `runtimes.ssh.launch`），规则集中在 `web/lib/cliInjectionRules.ts`。
- §2.1 / §2.2 两张表保留为批 0 之前的盘点，补齐后的取值见 §5 与 `web/lib/cliInjectionProfiles.json`。

## 3. 各 CLI 原生能力（官方文档调研）

| CLI | MCP 配置（项目级） | 远程 transport | 启动时临时注入 MCP | 启动时临时挂载 skills | 共同 skills 目录 |
|---|---|---|---|---|---|
| claude | `.mcp.json` | http/sse/ws | `--mcp-config` + `--strict-mcp-config` | `--plugin-dir`、`--add-dir` | `.claude/skills`（**不读** `.agents`） |
| codex | `.codex/config.toml` | http | `-c mcp_servers.*` | `-c skills.config`（能否挂外部路径**待实测**，目前实际在用） | `.agents/skills` |
| opencode | `opencode.json` | http | `OPENCODE_CONFIG`（2.0 下待实测） | 配置里的 `skills` 数组（可经同一份每会话配置传入） | `.agents`、`.claude`、`.opencode` |
| cursor | `.cursor/mcp.json` | http/sse | ❌ | `--plugin-dir` | `.agents`、`.cursor`、`.claude`、`.codex` |
| grok | `.grok/config.toml`，另读 `.mcp.json` | http | ❌（`grok mcp add`） | `--plugin-dir` | `.grok`、`~/.agents`，兼容 Claude 插件 |
| pi | `.pi/mcp.json` | http | 扩展里 `registerMcpServer`（已用） | `--skill <path>`（可重复） | `.pi`、`.agents` |
| omp | `.omp/mcp.json` | http/sse | ❌（只有 TUI） | `--plugin-dir`、`-e` | `.omp`、`.agents`、`.claude` 等 |
| jcode | `.jcode/mcp.json`、`.mcp.json` | 来源矛盾，**待实测**（v0.96 说支持 http/sse） | ❌ | 未确认 | `.jcode`、`.agents`、`.claude` |
| kimi | `.kimi-code/mcp.json`（需 trust） | http/sse | ❌ | `--skills-dir`（**会替换**自动发现） | `.kimi-code`、`.agents` |
| gemini（个人账号已停服） | `.gemini/settings.json` | http/sse | ❌ | ❌ | `.gemini`、`.agents` |
| antigravity | `.agents/mcp_config.json`（远程用 `serverUrl` 键） | http（无 SSE） | ❌ | `--add-dir`（会读该目录下的 `.agents/`） | `.agents`、`~/.gemini/config/skills` |

**两点关键观察：**
- **`.agents/skills` 已成事实标准**：除 Claude 外，9 家都读它。
- **「项目级 MCP 文件 + 收据回收」能覆盖所有没有临时注入参数的 CLI**。omp 和 jcode 已经验证过这条路（`sync_adapter_project_mcp`）。代价是写进用户的仓库目录，所以要靠收据回收，并加入 `.git/info/exclude`。

## 4. 设计原则

1. **注入通道按侵入性从低到高选，能用前面的就不用后面的：**
   1. 启动参数或环境变量，指向每会话临时文件（零残留）
   2. 项目级配置文件，靠收据驱动增删、自动排除出 git、会话结束回收
   3. 用户级配置文件，只作最后手段，必须带收据并在退出时清理；新接入一律不用

   现有的 cursor 和 grok 用户级写入，要迁到第 2 档。
2. **单一能力描述**：每个 adapter 返回一个结构化的 `InjectionProfile`，前端所有门控都读它，删掉 §1 列的那 7 张散表。
3. **诚实守卫**：对每个 CLI，喂一份满配的 context（ccpanes + 共享 http + 带 headers 的 remote + 工作空间 stdio/http + 技能挂载路径 + 用户技能），断言描述里声明支持的每一项都能在 argv、env 或写出的文件里找到证据。声明了但找不到就让 CI 失败，「UI 说可用、实际收不到」从此进不了主干。
4. **降级必须用户可见**：做不到的项（隔离、SSE、SSH 下的 MCP）在启动器和启动档卡片里明确写出来，不能静默跳过。
5. **调用方身份**：凡是用 HTTP 接 ccpanes 的，URL 都带 launchId；共享文件不能带每会话身份的地方（项目级文件），改用 ctl stdio 代理（参数带身份）或环境变量展开（`${CC_PANES_LAUNCH_ID}`，要求该 CLI 支持展开）。

## 5. 目标形态（每个 CLI 补齐后）

| CLI | ccpanes 自身 MCP | 共享 + 工作空间 MCP | 隔离 | 技能挂载 | 说明 |
|---|---|---|---|---|---|
| claude | 不变 | 不变 | 隔离时加 `--strict-mcp-config`，并且不再合并用户全局 server | 不变 | |
| codex | 不变 | 不变 | 不变 | 不变；WSL 改为挂载，不再拷贝 | |
| opencode | 不变 | 补 headers 与工作空间层（写进同一份 `OPENCODE_CONFIG`） | 在每会话配置里把未选中的 server 显式 disabled | 配置里的 `skills` 数组指向挂载目录 | 先验证 2.0 下的配置键 |
| cursor | 改为项目级 `.cursor/mcp.json` 加收据 | 同一份文件 | ⚠ 只能声明不支持 | `--plugin-dir`（需要 staging 成 Cursor 插件布局） | 去掉用户级持久写入 |
| grok | 改为项目级 `.mcp.json` 或 `.grok/config.toml` 加收据，带身份 | 同一份文件 | ⚠ | `--plugin-dir`（兼容 Claude 插件，可直接复用 builtin 插件目录） | |
| pi | 不变 | 放开 headers | ⚠ | 每个挂载路径传一次 `--skill` | 修掉 PiSkill 压掉回退的问题 |
| omp | 不变 | 不变 | ⚠ | `--plugin-dir` | 修并发后写覆盖（每会话一个条目名） |
| jcode | 不变（stdio 代理） | 实测远程 MCP，可用就放开 http | ⚠ | 无临时参数 → 走提示词回退，或在 `.jcode/skills` 写收据 | 修正「显示可用」的误报 |
| kimi | 新接：项目级 `.kimi-code/mcp.json` 加收据 | 同一份文件 | ⚠ | `--skills-dir`：把用户级和项目级默认目录连同我们的挂载目录**一起显式传入**，抵消它的替换语义 | 项目级 MCP 需要 trust，交互模式下怎么处理要实测 |
| antigravity | 新接：项目级 `.agents/mcp_config.json`（`serverUrl`）加收据 | 同一份文件 | ⚠ | `--add-dir <staging>`，staging 目录里放 `.agents/skills/` 的符号链接 | 两项都要实测 |
| gemini | 低优先：项目级 `.gemini/settings.json` | 同一份文件 | `--allowed-mcp-server-names` 能真隔离 | 写 `.agents/skills` 收据 | 个人账号已停服，排最后 |

**挂载目录 staging：** 内置、工作空间、启动档技能三类来源，先拼成每会话一个临时目录（全用符号链接，Windows 不能建链接时退回复制），再按上表交给各 CLI。复用 `mcp_config_lifecycle` 做 GC。Claude 和 Codex 不受影响。

## 6. 分批

### 批 0 · 能力单源与诚实化（先做，后面所有批都依赖它）

- 新增 `InjectionProfile`：
  - MCP 部分：ccpanes 通道、共享通道、工作空间层、可用的 transport 集合、是否支持 headers、隔离程度（完整 / 只能声明 / 无）、是否带身份。
  - 技能部分：挂载方式（plugin-dir / skill 参数 / add-dir / 配置数组 / 项目文件 / 无）、能否提示词回退。
  - 运行时支持：WSL、SSH。
- 后端 `remote_mcp_supported`、代理白名单、`resolve_skill_compatibility` 全部改为读它。
- 新增 Tauri 命令下发给前端；删除 `MCP_UNSUPPORTED_CLIS`、`TOOL_MCP_HINT_KEYS` 的硬编码、`EXTERNAL_SKILL_GROUPS.applicableTools`、`launchMenu.supportsSsh`。
- 加诚实守卫测试（§4 第 3 条）。第一次跑会把 jcode 的技能和 cursor 的技能判红，就照实把描述改成「不支持」。
- 修正 docs/97:88 和 terminal_service.rs:222 里过时的说法。
- 把 `include_ccpanes_mcp` 和 `skip_mcp` 拆开：关掉 ccpanes 自身 MCP 时，不再连带关掉共享和工作空间层。

**验收：** UI 显示的每一项「可用」都有守卫证据；所有 CLI 的门控来自同一个来源。

### 批 1 · 技能挂载补齐

- 建每会话技能 staging 目录（§5）。
- 按 §5 接 grok、cursor、omp 的 `--plugin-dir`，pi 的 `--skill`，kimi 的 `--skills-dir`（显式传入默认目录），antigravity 的 `--add-dir`，opencode 的配置 `skills` 数组。
- 提示词回退的规则改为：只要 adapter **实际没有消费**挂载路径，就走回退（读描述，不再看投递模式里有没有 Native\*）。
- 实测 daemon 模式下 `sidecar_resource_dir` 为 None 的影响；若属实，改为把资源目录经启动请求传给 daemon。

**验收：** 对每个 CLI，内置、工作空间、启动档三类技能各起一个会话，在 CLI 里列技能都能看到（实机清单见 §7）。

**批 1 已落地（feat/mcp-skills-parity）：**

| CLI | `skills.mount` | 参数形态（官方来源） | 提示词通道 |
|---|---|---|---|
| grok | pluginDir | 每个挂载根一次 `--plugin-dir`，Claude 插件布局直接用（docs.x.ai/build/features/skills-plugins-marketplaces） | `--rules` |
| omp | pluginDir | 每个挂载根一次 `--plugin-dir`（omp docs/cli-reference.md；`discovery/plugin-dir-roots.ts` 把它当 ClaudePluginRoot） | `--append-system-prompt` |
| pi | skillFlag | 每个技能目录一次 `--skill <path>`（pi-mono coding-agent docs/cli.md） | `--append-system-prompt` |
| kimi | skillsDir | `--skills-dir` 可重复但**替换**自动发现，所以把存在的 `<项目根>/.kimi-code/skills`、`<项目根>/.agents/skills`、`$KIMI_CODE_HOME/skills`（默认 `~/.kimi-code/skills`）、`~/.agents/skills` 连同 `<挂载根>/skills` 一起传；没有挂载时不传（kimi-code/en/reference/kimi-command、customization/skills） | 无 |
| cursor | pluginDir | 每会话 staging 摆成 Cursor 插件（`.cursor-plugin/plugin.json` + `skills/`）后 `--plugin-dir`（cursor.com/docs/cli/reference/parameters、docs/reference/plugins） | 无 |
| antigravity | addDir | 每会话 staging 里摆 `.agents/skills/<name>` 后 `--add-dir`（antigravity.google/docs/cli/reference、docs/skills） | 无 |
| opencode | configArray | 每会话 `OPENCODE_CONFIG` 的 `skills.paths`（对象形态；1.17 拒绝数组形态，新版 schema 两种都收） | `instructions` |
| jcode / gemini | none | 无临时挂载参数，也没有提示词通道——如实标 None，什么都送不到 | 无 |

- staging：`<data_dir>/skill-staging/<session_id>/`（`cc-cli-adapters/src/skill_mounts.rs`），`skills/<name>` 为指向挂载源的符号链接，建不了链接时复制；同时放 `.claude-plugin/plugin.json`，按需放 `.cursor-plugin/plugin.json` 与 `.agents/skills/`。PTY 退出时打退休标记，下次 staging 时回收退休超过 1 小时的目录（与 `mcp_config_lifecycle` 同一条「没有退休证据就不删」规则）。Claude / Codex 路径不变。
- 提示词回退判据：`InjectionProfile::uses_skill_prompt_fallback(runtime)` = 有提示词通道 且 该运行时没消费挂载（本机看 `skills.mount`；WSL / SSH 不经 adapter，只有该运行时技能支持为 Full 才算消费）。trait 默认值改为按 `supports_system_prompt` 给出通道，不再看投递模式里有无 Native*，PiSkill 不再压掉回退。本机消费挂载后 grok / opencode 不再内联可移植技能；grok WSL 仍走提示词（WSL 技能支持改标 Partial）。
- daemon 资源目录：确认 daemon 进程从不调用 `set_sidecar_resource_dir`，`portable_bundled_skill_prompt` 与托管 Pi 技能发布在 daemon 模式下拿到 None。修法：app 启动时记进程级资源目录（`services::sidecar_resource`），daemon 客户端在创建请求里带 `sidecarResourceDir`，daemon 收到后记进本进程，`TerminalService` 自身字段为空时退回它（旧 daemon 忽略该字段，行为不变；需要重建并替换 daemon 二进制才生效）。
- 守卫：诚实守卫的挂载根改为真实插件布局（含一个技能），staging 型要求 argv 里出现 staging 路径且链接到技能正文；`tests/skill_mount_args.rs` 钉住各 CLI 的参数形态。

### 批 2 · MCP 补齐

- 抽一个通用的项目级 MCP 文件写入器：键名、格式（JSON / TOML）、远程 URL 的键（`url` / `serverUrl` / `httpUrl`）都可配置，做法同 omp 的收据流程。
- 新接 kimi、antigravity；gemini 放最后。
- cursor、grok 从用户级迁到项目级；第一次启动时清掉我们以前写进用户级文件的旧条目（按收据或条目名前缀）。
- opencode 补 headers 和工作空间层；pi、omp 放开 headers；jcode 视实测结果放开 http。
- 各家的身份方案按 §4 第 5 条落地。

**验收：** 对每个 CLI，用一个 stdio 共享 MCP、一个带鉴权 header 的远程 MCP、一个工作空间层 MCP 起会话，三个都能调通；ccpanes 工具调用时日志里能看到正确的 launchId。

**批 2 已落地（feat/mcp-skills-parity）：**

通用写入器 `cc-cli-adapters/src/project_mcp.rs`（渲染 / 入口 / 回收）+ `project_mcp_files.rs`（JSON / TOML 同步、git、租约）+ `project_mcp_dialects.rs`（各家方言）。沿用 `sync_adapter_project_mcp` 的收据契约（只动自己写过的条目、同名用户条目跳过、语义不变零写入、解析失败原样保留），新增：

- **方言**：文件路径、JSON / TOML、顶层键（`mcpServers` / `mcp_servers`）、远程 URL 键（`url` / `serverUrl` / `httpUrl`）、SSE 的写法（`transport:"sse"` / `type:"sse"` / Gemini 的 `url`）、请求头、环境变量引用语法。
- **不落秘密、带身份**：能在配置里展开环境变量的 CLI（cursor `${env:X}`，grok / omp / jcode `${X}`），ccpanes 写成 `http://127.0.0.1:${PORT}/mcp?launchId=${CC_PANES_LAUNCH_ID}` + `Authorization: Bearer ${CC_PANES_API_TOKEN}`，远程 MCP 的请求头也换成 `${CC_PANES_MCP_HEADER_<SERVER>_<HEADER>}`，真实值经本会话 env 注入——文件内容对所有会话一致，并发会话各自展开成自己的身份。不能展开的（kimi / antigravity / gemini）ccpanes 走 cc-panes-ctl stdio 代理，参数只有 `mcp-proxy`，实例与身份来自继承的 `CC_PANES_DATA_DIR` / `CC_PANES_LAUNCH_ID`（ctl Auto 模式本来就读它们；dev / release 同项目并发也不会串台），Gemini 会清洗 stdio 子进程环境，故在 `env` 块里用 `$VAR` 显式转发。代理不可用时退回 HTTP：kimi 用 `bearerTokenEnvVar`，antigravity / gemini 只能写字面 token（不带 launchId）。终端服务对 ccpanes 通道为 ProjectFile / StdioProxy 且声明可走代理的 CLI 强制启用代理（不受 `CCPANES_MCP_PROXY` 灰度约束）。
- **git**：目标文件已被 git 跟踪时不写（不弄脏用户仓库）；写入后把文件与 `.bak` 加进 `.git/info/exclude`（`git rev-parse --show-prefix --git-path info/exclude`，worktree 落在共享 common dir）。
- **回收**：每次写入记会话租约 `<data>/cli-adapters/project-mcp-leases/<session>.json`；PTY 退出时（`cleanup_session_mcp_configs`）删租约，同 (CLI, 项目) 没有别的 7 天内租约时按收据清掉我们的条目。

| CLI | 批 0 | 批 2 后 |
|---|---|---|
| kimi | 无 MCP | 项目 `.kimi-code/mcp.json`；ccpanes 经 ctl 代理（身份 ✅）；共享 + 工作空间 ✅；HTTP / SSE + 字面请求头；隔离只能声明；有条目时注入 `KIMI_CODE_TRUST_WORKSPACE=1` |
| antigravity | 无 MCP | 项目 `.agents/mcp_config.json`（`serverUrl`）；ccpanes 经 ctl 代理（身份 ✅）；共享 + 工作空间 ✅；只 HTTP（无 SSE）+ 字面请求头 |
| gemini | 无 MCP | 项目 `.gemini/settings.json`（HTTP=`httpUrl`、SSE=`url`）；ccpanes 经 ctl 代理（`env` 块转发身份）；共享 + 工作空间 ✅ |
| cursor | 用户级 `~/.cursor/mcp.json`，身份 ❌，无工作空间层 | 项目 `.cursor/mcp.json`；`${env:…}` 占位符（身份 ✅）；共享 + 工作空间 ✅；HTTP / SSE + 请求头占位；首次启动清掉用户级旧条目（签名匹配的 `ccpanes` + 与共享同名且仍是 `{"url":…}` 原样的条目，落标记后不再碰用户级文件）；`cleanup_user_injections` 语义不变 |
| grok | 用户级 `~/.grok/config.toml`，身份 ❌，无工作空间层 | 项目 `.grok/config.toml`（TOML，`enabled = true`）；`${VAR}` 占位符（身份 ✅）；共享 + 工作空间 ✅；HTTP + 请求头；用户级旧条目同样一次性清理（删表时保留用户写在表头上方的注释） |
| opencode | 共享无请求头、无工作空间层 | 同一份 `OPENCODE_CONFIG` 补请求头与工作空间层（stdio → `local` 的 command 数组 + environment，HTTP → `remote`；SSE 跳过） |
| pi | 共享无请求头、身份 ❌ | 扩展桥带远程请求头；ccpanes URL 带本会话 launchId（每会话文件，不会被覆盖） |
| omp | 字面 token、身份 ❌、无请求头 | 改走通用写入器：`${VAR}` 占位符（身份 ✅，文件里不再有 token）+ 请求头占位 |
| jcode | 只 stdio，身份 ❌ | 代理参数不再写 `--launch-id`（身份走环境变量 ✅）；放开 HTTP / SSE + `${VAR}` 请求头（v0.96+ 才认，旧版只会跳过）；共享仍优先原始 stdio 定义；代理不可用时退回 HTTP 占位符 |
| claude / codex | — | 不变 |

前端「哪些 CLI 拿得到」（资源中心 `remoteUnsupportedByProfile`、启动档 MCP 卡片提示、启动器注入摘要）读描述，随之更新。

### 批 3 · 隔离

- Claude 加 `--strict-mcp-config`，隔离时不再合并 `~/.claude.json`。
- opencode 在每会话配置里显式 disabled。
- gemini 加 `--allowed-mcp-server-names`。
- 其余 CLI 在描述里如实标为「只能声明」，启动档勾选隔离时提示哪些 CLI 做不到。

**批 3 已落地（feat/mcp-skills-parity）：**

| CLI | 隔离 批 2 → 批 3 | 机制（官方来源） |
|---|---|---|
| claude | none → **full** | 隔离时加 `--strict-mcp-config`（`claude --help`：Only use MCP servers from --mcp-config, ignoring all other MCP configurations），并且只把启动档允许的 `~/.claude.json` server 合并进每会话 `--mcp-config`；启动档 MCP 全关（没有 `--mcp-config`）时同样传，会话一个 server 都不加载 |
| opencode | none → **full** | 把 OpenCode 会读的配置（全局 `config.json`/`opencode.json(c)`、启动目录到 git 根的 `opencode.json(c)` 与 `.opencode/`、`~/.opencode/`、`OPENCODE_CONFIG_DIR`）里出现、但启动档没选中的 server 写成 `enabled:false`，经 **`OPENCODE_CONFIG_CONTENT`** 注入（与父进程已有的值合并；解析不了就保留原值并放弃隔离）。不能写进每会话 `OPENCODE_CONFIG`：加载顺序是 全局 → `OPENCODE_CONFIG` → 项目文件 → `.opencode/` → `OPENCODE_CONFIG_CONTENT`（sst/opencode v1.17.11 `packages/opencode/src/config/config.ts`、`config/paths.ts`），项目文件里显式的 `enabled:true` 会盖回去。组织账号的远程配置与 MDM 托管配置排在它之后，不在隔离范围 |
| gemini | declareOnly → **full** | `--allowed-mcp-server-names <本次写入的条目 + 启动档允许的名字>`（google-gemini/gemini-cli `packages/cli/src/config/config.ts`：给了这个参数就覆盖 `mcp.allowed` 且不看 `mcp.excluded`；`packages/core/src/tools/mcp-client-manager.ts`：名单为空等于不过滤，所以「一个都不放行」传哨兵名 `__ccpanes_no_mcp__`） |
| codex | full | 不变（`-c mcp_servers.<x>.enabled=false`） |
| cursor / grok / kimi / antigravity / pi / omp / jcode | declareOnly | 官方文档里没有按次启动的禁用 / 白名单通道：cursor-agent 只有持久的 `mcp disable`；grok 的项目 `config.toml` 同名条目会整体替换用户级，但那是同项目会话共享的持久文件，且 `.mcp.json` / `~/.claude.json` 等兼容来源管不到；Kimi Code 的 `enabled:false` 同样只能写持久的 `mcp.json`。如实标「只能声明」 |

- 前端：启动档 MCP 卡片在「启动档收窄了 MCP」（与 `launch_profile_isolates_mcp` 同口径）且该 CLI 的 `isolation` 不是 `full` 时显示提示（`mcpIsolationGap`，读描述）。
- 守卫：完整隔离的证据改为「用户 server 的命令不出现」并且三种机制之一可见（逐个禁用提到了它 / argv 有 `--strict-mcp-config` / `--allowed-mcp-server-names` 的名单里没有它）；守卫额外给 OpenCode 与 Gemini 种了用户级配置，并新增「不隔离时不出现隔离参数」的反向用例。
- Kimi 托管 Provider：Kimi Code 没有 `--config-file`（那是已归档的 Python 版 kimi-cli 的参数，传给 Kimi Code 启动即失败；`kimi-code/en/reference/kimi-command` 的参数表里没有它），普通 `KIMI_API_KEY` 也不读（`configuration/overrides`「Provider credentials」）。改为文档里的 `KIMI_MODEL_NAME` / `KIMI_MODEL_API_KEY` / `KIMI_MODEL_PROVIDER_TYPE=kimi` / `KIMI_MODEL_BASE_URL`（`configuration/env-vars`「Define a model from environment variables」），托管时不再传 `--model`（`-m` 优先级更高，会去找用户 config 里未必存在的别名），也不再写每会话 JSON、不注入旧 CLI 的 `KIMI_SHARE_DIR`。`KIMI_MODEL_NAME` 必填，托管模式没选模型时拒绝启动并说明原因。

### 批 4 · WSL / SSH

- **WSL**：`build_wsl_supported_cli_command` 改为走 adapter 的 context，不再固定 `skip_mcp:true`。路径转换和 guest 内的文件写入抽到 WSL 适配层。Codex 的内置技能从拷贝改为挂载或符号链接。opencode 在 WSL 下补上提示词。
- **SSH**：MCP 需要反向隧道，**本计划不做**，只在描述里如实标出。技能经提示词回退或远端 staging 投递，可选。

**批 4 已落地（feat/mcp-skills-parity）：**

| CLI | WSL MCP | WSL 技能 | 做法 |
|---|---|---|---|
| opencode | none → **partial** | none → **partial** | WSL 分支改用本机同一个 adapter 生成每会话 `OPENCODE_CONFIG`（ccpanes + 共享 + 工作空间层 HTTP MCP、`instructions`、托管 Provider 合在一份里），宿主写文件后把 `instructions` 路径换成 `/mnt/...`、回环 MCP 地址换成探活得到的 Windows 主机（`terminal_service/wsl_opencode.rs`，纯数据变换，全平台编译 + 测试）。技能不挂载，内置可移植技能与工作空间技能走提示词回退（以前 WSL 下提示词整段丢失）。Partial 的原因：工作空间 stdio 条目是宿主命令；远程不带请求头 / SSE；隔离做不到（要禁用的名字在 guest 的配置里） |
| claude | partial（不变） | full（不变） | 启动档隔离时 WSL 同样加 `--strict-mcp-config`。降级：guest 自己 `~/.claude.json` 里被启动档选中的 server 宿主侧合并不进来，会一起被挡掉 |
| codex | partial（不变） | full（不变） | 内置技能从**拷贝**进 guest `~/.codex/skills` 改为**符号链接**到宿主 managed 目录的 `/mnt/...` 路径（清单里记着的旧拷贝换成链接、关掉的 `ccpanes-*` 删除、用户同名真实目录不动、旧版本戳删除；`build_wsl_codex_skill_link_prelude`，前置块在 macOS 的 bash 里真跑过一遍）。没有改用本机那条 `-c skills.config`：它在 codex 0.169.0 里加载不了外部目录（§7 #1） |
| 其余 | 不变 | 不变 | WSL 仍不经 adapter；项目文件型 CLI 要在宿主侧写 guest 路径下的项目文件、ctl 代理要走 interop，本批没做 |
| SSH（全部） | none | none | 描述本来就标 none；启动档绑定 SSH / WSL 时 MCP 卡片按描述说明该运行时下到不了 / 只到一部分；右键菜单注入摘要的 WSL 技能状态改读 `runtimes.wsl.skills`（以前一律显示「已挂载」） |

本机（macOS）编译不到、只能靠代码审读的部分（全在 `#[cfg(windows)]` 下）：`build_wsl_supported_cli_command` 里新增的 OpenCode 配置生成与 Claude `--strict-mcp-config`、OpenCode 被排除出托管 Provider 计划、`build_wsl_codex_skill_sync_commands` 改调链接前置块、`terminal_service.rs` 里 Windows 主机探活加上 OpenCode。纯逻辑（`wsl_opencode.rs`、`build_wsl_codex_skill_link_prelude`、`WslWorkspaceInjection::isolate_mcp`）在 `cfg(any(windows, test))` 下，本机测试覆盖。

### 批 5 · 入口

- 技能市场的「安装到」在界面上开放工作空间目标（hook 已经支持）。
- MCP 市场保持只写共享层（由单源负责分发，这个设计是对的），在卡片上显示「当前启动档下哪些 CLI 能拿到它」，数据来自描述。
- 恢复项目 Skill 管理时，`PROJECT_SKILL_ROOTS` 补齐 opencode、grok、pi、omp、jcode、kimi、antigravity 的条目。

## 7. 必须实测、不能凭文档定的事项

| # | 事项 | 影响 | 结论 |
|---|---|---|---|
| 1 | Codex 的 `skills.config` 能否挂载 `~/.codex/skills` 之外的目录（当前实现依赖它） | 批 1 | **codex 0.169.0 实测：不能。** 临时 `CODEX_HOME` 下用 `codex debug prompt-input` 看模型可见的技能清单：`-c skills.config=[{path=…,enabled=true}]` 指向插件根、`skills/` 目录、单个技能目录、`SKILL.md` 文件四种写法，技能都不出现；同一个技能放进 `$CODEX_HOME/skills`、项目 `.agents/skills`、或以**符号链接**放进 `$CODEX_HOME/skills` 都出现。即本机 Codex 的「按会话挂载内置 / 工作空间技能」实际没有生效（守卫只看到 argv 里有路径），**未修**：可行的通道（`~/.codex/skills` 或 `~/.agents/skills` 下的链接）都要写用户的 CLI 主目录，与 docs/97 的零写入承诺冲突，需要单独决策。WSL 已改为链接（批 4） |
| 2 | OpenCode 2.0 下 `OPENCODE_CONFIG` 和 `mcp.servers` 的键名 | 批 1、2 | **opencode 1.17.11 实测**：MCP——adapter 生成的配置经 `opencode debug config` 解析通过，`opencode mcp list` 列出共享远程、共享桥、工作空间 stdio 三个条目并真的去连（本地起一个记录请求头的 HTTP 服务，收到的 POST 带着配置里的 `X-Probe` 头）；技能——`OPENCODE_CONFIG` 生效；`skills` 只收对象 `{"paths":[...]}`，数组形态报 `Expected object`（官网 V2 文档写的是数组，新版 schema 两种都收，故用对象）。用 adapter 生成的每会话配置挂内置 + 工作空间两个根，`opencode debug skill` 从 1 个变成 33 个（31 个 `ccpanes-*` + 工作空间技能 + 自带 1 个），符号链接的技能目录同样可见。MCP 键名：官网 schema 仍收旧形 `mcp.<name>`（`type`/`url`/`enabled`/`headers`，标 deprecated），新形是 `mcp.servers.<name>` + `disabled` |
| 3 | JCode 的远程 MCP（文档说只支持 stdio，changelog 说支持 http/sse） | 批 2 | 官方 docs/MCP_REMOTE.md（master）明确：stdio / Streamable HTTP / SSE 都支持，`type` 取 `http`/`streamable-http`/`sse`，URL 与请求头展开 `${VAR}`。已放开；本机未装 jcode，未实机，旧版（v0.84 实测只认 stdio）会跳过远程条目 |
| 4 | Kimi 项目级 MCP 的 trust 在交互模式下如何处理 | 批 2 | 官方文档：未信任文件夹里的项目级 MCP 在 trust 提示里列出、默认选「信任」；headless 不能弹提示，`KIMI_CODE_TRUST_WORKSPACE=1` 让本进程信任工作区。我们在写了条目时注入它（与 cursor 始终 `--trust` 同口径；代价是该进程也信任仓库里其他项目级配置）。本机未装 kimi，交互模式下该变量是否同样跳过提示未实测 |
| 5 | Antigravity 的 `--add-dir` 是否加载 staging 目录里的 `.agents/skills`；`mcp_config.json` 里能否展开 `${VAR}` | 批 1、2 | 本机未装 agy，未实测。`${VAR}`：官方 MCP 文档没写（changelog 只提到插件变量），按不支持处理，ccpanes 走 ctl 代理。文档：`--add-dir` 把目录加进工作区，CLI 读每个工作区根的 `.agents/skills/`（changelog 有 `/add-dir` 后技能动态重载的修复）；风险是它对 `.agents/skills.json` 里经符号链接的条目会跳过，`.agents/skills/` 目录里的链接是否同样被跳过未知——实测若不加载，staging 对 agy 改为复制 |
| 6 | Cursor 的 `--plugin-dir` 要求的插件布局 | 批 1 | 文档已说清（cursor.com/docs/reference/plugins）：按清单位置识别，Cursor 插件 = `.cursor-plugin/plugin.json`（必填 `name`），`skills/` 下含 `SKILL.md` 的子目录默认发现；Agent Plugin = 根 `plugin.json`。本机未装 cursor-agent，`--plugin-dir` 下技能目录为符号链接时是否加载未实测（文档只说 `~/.cursor/plugins/local` 里指向外部的链接会被跳过） |
| 7 | daemon 模式下 portable 提示词是否真的丢失 | 批 1 | 读代码确认属实（daemon 只建 `TerminalService` 不调 `set_sidecar_resource_dir`），已修（见批 1） |
| 8 | Grok 项目级 `.mcp.json` 与 `.grok/config.toml` 都存在时的优先级 | 批 2 | 官方文档：`.mcp.json` / `.cursor/mcp.json` / `~/.claude.json` 等 compat 来源合并在 config.toml **之下**，项目 `.grok/config.toml` 同名条目整体替换用户级——故选 `.grok/config.toml`。本机未装 grok，未实机 |

| 9 | Claude `--strict-mcp-config` 能否挡住 `~/.claude.json` 与项目 `.mcp.json` | 批 3 | **claude 2.1.330 实测**：临时 `CLAUDE_CONFIG_DIR` 的 `.claude.json` 与项目 `.mcp.json` 各放一个启动即写标记文件的 stdio server，`-p` 跑一次：不带 strict 三个都启动；带 strict 只启动 `--mcp-config` 里那个；只带 strict、不带 `--mcp-config` 一个都不启动 |
| 10 | OpenCode 的 `enabled:false` 放在哪一层才压得住项目文件 | 批 3 | **opencode 1.17.11 实测**：用户级与项目级各一个 stdio server（项目那个显式 `enabled:true`）：写进 `OPENCODE_CONFIG` 只挡住用户级那个，项目那个仍启动；写进 `OPENCODE_CONFIG_CONTENT` 两个都显示 `disabled` 且都没启动 |

每一项实测结论都写回本文对应行，附 CLI 版本号。

## 8. 不做

- 不往用户的 CLI 主目录（`~/.xxx/skills`、`~/.xxx/mcp.json`）做新的持久写入（理由同 docs/97 的「零写入」承诺）。
- 不做 SSH 下的 MCP 反向隧道。
- 不为 Gemini 个人账号做任何新投入（已停服），只做低成本的项目文件注入。
- 不改 MCP 市场「只写共享层」的设计。
