# 110 · 全 CLI 的 MCP / Skills 适配计划

> 状态：计划稿（2026-11-21），未排期。实施时每批单独抽 plan。
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

### 批 2 · MCP 补齐

- 抽一个通用的项目级 MCP 文件写入器：键名、格式（JSON / TOML）、远程 URL 的键（`url` / `serverUrl` / `httpUrl`）都可配置，做法同 omp 的收据流程。
- 新接 kimi、antigravity；gemini 放最后。
- cursor、grok 从用户级迁到项目级；第一次启动时清掉我们以前写进用户级文件的旧条目（按收据或条目名前缀）。
- opencode 补 headers 和工作空间层；pi、omp 放开 headers；jcode 视实测结果放开 http。
- 各家的身份方案按 §4 第 5 条落地。

**验收：** 对每个 CLI，用一个 stdio 共享 MCP、一个带鉴权 header 的远程 MCP、一个工作空间层 MCP 起会话，三个都能调通；ccpanes 工具调用时日志里能看到正确的 launchId。

### 批 3 · 隔离

- Claude 加 `--strict-mcp-config`，隔离时不再合并 `~/.claude.json`。
- opencode 在每会话配置里显式 disabled。
- gemini 加 `--allowed-mcp-server-names`。
- 其余 CLI 在描述里如实标为「只能声明」，启动档勾选隔离时提示哪些 CLI 做不到。

### 批 4 · WSL / SSH

- **WSL**：`build_wsl_supported_cli_command` 改为走 adapter 的 context，不再固定 `skip_mcp:true`。路径转换和 guest 内的文件写入抽到 WSL 适配层。Codex 的内置技能从拷贝改为挂载或符号链接。opencode 在 WSL 下补上提示词。
- **SSH**：MCP 需要反向隧道，**本计划不做**，只在描述里如实标出。技能经提示词回退或远端 staging 投递，可选。

### 批 5 · 入口

- 技能市场的「安装到」在界面上开放工作空间目标（hook 已经支持）。
- MCP 市场保持只写共享层（由单源负责分发，这个设计是对的），在卡片上显示「当前启动档下哪些 CLI 能拿到它」，数据来自描述。
- 恢复项目 Skill 管理时，`PROJECT_SKILL_ROOTS` 补齐 opencode、grok、pi、omp、jcode、kimi、antigravity 的条目。

## 7. 必须实测、不能凭文档定的事项

| # | 事项 | 影响 |
|---|---|---|
| 1 | Codex 的 `skills.config` 能否挂载 `~/.codex/skills` 之外的目录（当前实现依赖它） | 批 1 |
| 2 | OpenCode 2.0 下 `OPENCODE_CONFIG` 和 `mcp.servers` 的键名 | 批 1、2 |
| 3 | JCode 的远程 MCP（文档说只支持 stdio，changelog 说支持 http/sse） | 批 2 |
| 4 | Kimi 项目级 MCP 的 trust 在交互模式下如何处理 | 批 2 |
| 5 | Antigravity 的 `--add-dir` 是否加载 staging 目录里的 `.agents/skills`；`mcp_config.json` 里能否展开 `${VAR}` | 批 1、2 |
| 6 | Cursor 的 `--plugin-dir` 要求的插件布局 | 批 1 |
| 7 | daemon 模式下 portable 提示词是否真的丢失 | 批 1 |
| 8 | Grok 项目级 `.mcp.json` 与 `.grok/config.toml` 都存在时的优先级 | 批 2 |

每一项实测结论都写回本文对应行，附 CLI 版本号。

## 8. 不做

- 不往用户的 CLI 主目录（`~/.xxx/skills`、`~/.xxx/mcp.json`）做新的持久写入（理由同 docs/97 的「零写入」承诺）。
- 不做 SSH 下的 MCP 反向隧道。
- 不为 Gemini 个人账号做任何新投入（已停服），只做低成本的项目文件注入。
- 不改 MCP 市场「只写共享层」的设计。
