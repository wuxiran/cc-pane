# CC-Panes Provider 双模式完整修复提示词

> 用途：把本文件完整交给高级 AI，让它在一轮任务中完成调研、实现、测试和验收。
>
> 目标仓库：`F:\C26\demo\cc-pane`
>
> 只读参考仓库：`F:\C26\gitee.com\zhengjunkj\ccpanel`
>
> 调研基线日期：2026-08-03。代码会继续变化，本文列出的文件路径和现状只能作为线索，执行时必须重新读取当前工作树。

---

## 给执行 AI 的完整提示词

你现在负责修复并完善 CC-Panes 的 Provider 系统。不要只写分析、方案或 TODO；请在一轮任务中完成代码实现、迁移兼容、自动化测试、必要文档更新和最终验证。只有遇到无法从仓库、CLI 帮助或现有测试中确定，且不同选择会造成数据破坏的事项时才询问用户。其余情况自行做保守、可回滚的工程判断并继续。

### 1. 仓库、权限和工作方式

- 目标仓库是 `F:\C26\demo\cc-pane`，所有代码修改只允许发生在这里。
- 参考仓库是 `F:\C26\gitee.com\zhengjunkj\ccpanel`。它只用于理解产品行为和各 CLI 的差异化适配，不允许修改、格式化、提交或清理。
- 两个仓库都可能有用户未提交的工作。开始时先运行 `git status --short`。保留所有既有改动，不得 reset、checkout、clean 或覆盖用户文件。
- 目标仓库调研时存在未跟踪的 `build.bat`、`dev.bat`；它们不属于本任务，不要删除或改写。
- 参考仓库调研时本来就有大量未提交改动，其中包括 `src/components/ProviderManagerModal.tsx`。必须用 `git diff` 和 `git show HEAD:<path>` 区分已提交基线与工作树实验，不得把未提交实现当成唯一真相。
- 先完整阅读目标仓库的 `AGENTS.md`、`CLAUDE.md`、`README.md`、`package.json`、根 `Cargo.toml`，再开始改代码。
- 遵循现有架构：React Component -> Zustand Store -> TypeScript Service -> Tauri IPC -> Rust Command -> Service -> Repository/FS。组件不得直接散落 `invoke()`。
- 不做无关重构，不升级依赖，不改变终端渲染生命周期，不重写 PTY 核心，不提交或推送 Git，除非用户另行明确要求。

### 2. 最终目标

CC-Panes 当前注册的每一种一等 CLI 都必须支持两种明确、可预测的 Provider 启动模式：

1. **使用 CC-Panes Provider（Managed）**
   - 用户显式选择 CC-Panes 保存的 Provider，可选 Provider 下的模型。
   - CC-Panes 只对本次子进程做参数、环境或临时配置注入。
   - 注入必须足以压过该 CLI 原生配置中可能存在的默认 Provider，确保用户选中的 Provider 真正生效。
   - 不永久改写用户的 CLI Provider 配置；确需生成配置时使用 CC-Panes 数据目录内的会话级临时文件，并在会话结束后清理。

2. **使用 CLI 自带配置（Native）**
   - CC-Panes 不选择、不替换、不清空 Provider。
   - CLI 继续读取自己的登录态、环境变量、配置文件和外部切换工具的当前状态，例如 Claude Code/cc-switch、`~/.codex/config.toml`、OpenCode 配置、Kimi/Crush/Grok 自身配置。
   - Provider 子系统在该模式下不得添加或删除 Provider 环境变量，不得添加 Provider/模型覆盖参数，不得重定向 Provider 配置目录，不得写入用户原生 Provider 配置文件。
   - CC-Panes 原有的 MCP、hook、session、workspace、YOLO、主题等非 Provider 能力可以照常工作；“Native”只表示 Provider 所有权归 CLI，不表示关闭 CC-Panes 的全部集成。

必须覆盖目标仓库 `CliToolRegistry::with_builtin_adapters()` 当前注册的全部工具：

- Claude Code
- Codex
- Gemini CLI
- Kimi CLI
- GLM CLI（当前底层命令为 `crush`）
- OpenCode
- Cursor CLI
- Grok CLI

Plain shell 没有 Provider，不显示 Provider 选择器，后端收到 Provider 选择时应拒绝或规范化为 Native，不能注入 AI Provider 凭证。

必须覆盖三种运行环境：

- Local
- WSL
- SSH

如果某个 CLI 在某个运行环境本来就不受支持，UI 应隐藏该组合或后端返回明确的 Unsupported 错误；不得显示“可用”后静默退回另一种模式。

### 3. 统一语义，不再新增平行开关

复用现有 `LaunchProviderSelection`，不要再为每个 CLI 发明一个布尔开关：

| API 值 | 产品文案 | 精确语义 |
|---|---|---|
| `none` | 使用 CLI 自带配置 | 强制 Native；忽略 workspace/profile/global Provider 绑定，不做 Provider 注入或 Provider 清理 |
| `explicit` | 使用 CC-Panes Provider | 强制 Managed；`providerId` 必填、存在、启用且与当前 CLI 兼容，否则启动失败 |
| `inherit` | 跟随运行配置 | 解析本次请求、Launch Profile、兼容期 workspace 绑定；解析不到 Provider 时落到 Native，不得偷偷使用全局默认 Provider |

补充规则：

- `SYSTEM_PROVIDER_ID = "__system__"` 只是 UI/持久化兼容用的虚拟条目。进入统一解析器后必须归一为 `none`，不能把它当成一个真实 Provider 继续传给 adapter。
- `Provider.isDefault` / `default_is_system` 只用于管理界面的默认预选和旧数据兼容，不得绕过 `LaunchProviderSelection` 隐式接管终端。
- `explicit + 空 providerId`、`explicit + 不存在的 providerId`、`explicit + 不兼容的 ProviderType` 都是用户可见错误，禁止返回空 env 后继续启动。
- `none` 的语义是“不干预”，不是“清空环境”。不要在 Native 模式批量 `env_remove`，否则会破坏用户的 shell 环境和外部 Provider 切换工具。
- Managed 模式为了确定性，可以只清理“当前 CLI 已知且会与所选 Provider 冲突”的变量，再设置本次值；清理列表必须按 CLI 维护并有测试，不能清空所有环境变量。
- Resume、Recent Launch、复制 Tab、Pane 的 `+`、会话恢复必须保留原会话的 `providerSelection`。旧记录没有该字段时按迁移规则处理，不能一律改成 Managed。

### 4. 当前代码中已确认的线索

以下内容是调研线索，不是让你机械照抄。修改前逐项重新验证：

1. `cc-panes-core/src/models/launch_profile.rs` 已有 `LaunchProviderSelection::{Inherit, Explicit, None}`。
2. `cc-panes-core/src/models/provider.rs` 已有 `SYSTEM_PROVIDER_ID`，并说明系统条目代表不注入。
3. `cc-panes-core/src/services/provider_service.rs::get_env_vars(None)` 当前返回空 map，这是 Native 的正确基础，但“找不到显式 Provider”也返回空 map并继续，是错误的失败策略。
4. `cc-panes-core/src/services/terminal_service.rs::create_session` 在一个大函数内解析 Provider，当前大致是：
   - `none -> None`
   - `explicit -> request providerId`
   - `inherit -> request providerId.or(profile providerId)`
   这段解析应抽成可测试的单一决策函数/服务，不要继续让 Local、WSL、SSH 各自猜。
5. `web/components/launcher/LauncherProviderRow.tsx` 当前在 `explicit` 下列出全部 Provider，没有按 `draft.cliTool` 过滤。
6. 前端 `web/types/provider.ts` 自己维护 ProviderType -> CLI 映射；Rust adapter 的 `compatible_provider_types` 又维护一份。两份已经不一致，例如 `config_profile` 的可用范围。必须收口单一来源，至少让后端能力声明成为最终权威。
7. 后端创建会话时没有可靠拒绝不兼容组合。结果可能是“用户选择了 Provider，但 adapter 忽略它，CLI 又读回原生 Provider”，这是最危险的静默失败。
8. `cc-cli-adapters/src/codex.rs` 在提交 `8a87a0a` 后已经通过 per-launch `-c model_provider=...` 和专用密钥环境变量处理显式 Provider，并有“不选择时不覆盖原生 Provider”的单测。保留这条正确方向，不要重新引入隔离 `CODEX_HOME`，不要永久写 `~/.codex/config.toml`。
9. `cc-cli-adapters/src/opencode.rs` 的 Local 路径会生成会话配置，但 WSL 通用启动路径绕过 adapter，只导出 `provider_env`。需要验证 Local/WSL/SSH 的 Managed 效果是否一致，以及 Native 时 `OPENCODE_CONFIG` 是否会遮蔽用户原生 Provider 配置。
10. `cc-cli-adapters/src/kimi.rs` 只有 `adapter_options.kimiConfigMode == "native"` 才完全不生成配置/`KIMI_SHARE_DIR`。仅仅 `providerSelection=none` 未必进入该分支。Provider 模式必须成为这类行为的统一来源，不能要求用户同时拨两个开关。
11. `cc-cli-adapters/src/glm.rs` 当前即使没有 Provider，也会设置 `CRUSH_GLOBAL_CONFIG`、`CRUSH_GLOBAL_DATA` 并指向 CC-Panes 数据目录。这会让“CLI 自带配置”名不副实，必须拆分 Provider 原生模式与 CC-Panes 管理模式。
12. `cc-panes-core/src/models/provider.rs` 的 Grok `base_url` 当前只映射到 `XAI_BASE_URL`，代码注释已经说明该变量未确认生效。参考仓库使用 `GROK_MODELS_BASE_URL` 和 `GROK_CLI_CHAT_PROXY_BASE_URL`。应根据当前 Grok CLI 帮助/参考实现验证后修正，不能保留一个 UI 可填但实际无效的字段。
13. `web/utils/workspaceLaunch.test.ts`、`web/utils/launchHistory.test.ts`、session restore model/repository 已经有部分 `providerSelection` 覆盖，说明数据链路基础存在。不要推倒重建。
14. `docs/issue-provider-passing-inconsistency.md` 记录了早期各入口传递不一致；文件路径有些已经过时，但“所有入口必须复用一条解析链”的结论仍有效。
15. `docs/provider-design-decision.md` 的核心不变量仍适用：原始 CLI 配置是最低层底座，CC-Panes 默认尊重；本次显式选择优先级最高；不注入时也不主动清理已有 Provider env。

### 5. CCPanel 只读参考重点

不要整文件复制 CCPanel。按目标仓库的分层和命名重写，但要理解这些成熟行为：

- `src-tauri/src/config.rs`
  - Claude、Codex、Grok 使用不同 Provider/Model 数据形态。
  - Codex Provider 明确是 OpenAI Responses 兼容端点，不与 Claude 的 Anthropic 协议混用。
- `src/utils/providerConfig.ts`
  - 不同 CLI 有各自的 Provider -> launch env/args 转换。
  - Grok 的 base URL、Codex 的 context window/model metadata 不是通用环境变量能表达的。
- `src-tauri/src/cli_adapter/codex.rs`
  - 用内部 marker env 把前端选择传到 Rust，再翻译成临时 `-c` 覆盖。
  - 密钥通过 `env_key` 间接引用，不能出现在命令行。
- `src-tauri/src/cli_adapter/opencode.rs` 与 `src/utils/openCodeConfig.ts`
  - OpenCode Provider 是带 provider key、npm package、options、models 的结构，不能把所有供应商都粗暴映射成同一组 OpenAI env。
- `src/components/NewTerminalModal.tsx`
  - 各 CLI 分别解析 Provider、默认模型和启动参数。
- `src/store/appStore.ts`
  - 曾用 `codexUseCcpProviderOverride` 保护原生 Codex 配置，说明“CCPanel 注入”和“CLI 自带”必须是用户可控边界。

参考仓库本身也可能有旧注释与当前代码矛盾。只吸收经过测试证明的行为，不复制它的巨型组件、重复状态或前端直拼协议方式。

### 6. 必须先建立统一解析结果

在 Rust 核心层建立一个单一、可单测的 Provider 解析结果。名称可按现有风格调整，但语义至少应等价于：

```rust
enum ProviderMode {
    Native,
    Managed,
}

struct ResolvedProviderPlan {
    mode: ProviderMode,
    selection: LaunchProviderSelection,
    source: ProviderSource, // Explicit / LaunchProfile / LegacyWorkspace / Native
    provider: Option<Provider>,
    model_id: Option<String>,
}
```

要求：

- 输入至少包含 `cli_tool`、`provider_selection`、请求 `provider_id`、请求 `model_id`、解析出的 Launch Profile、兼容期 workspace provider。
- 输出是 Local、WSL、SSH、预览、历史记录共同使用的唯一有效结果。
- compatibility 以 adapter capability 为权威；前端过滤只是体验优化，后端必须再次验证。
- `ProviderType` 序列化名统一使用后端定义，保留 `open_ai` 对旧 `open_a_i` 的读取兼容。
- Managed 解析失败必须返回结构化 `AppError`，包含错误类别、CLI id 和 Provider id，但不得包含 API key、token 或完整配置内容。
- Preview 和实际 create_session 调用同一个 resolver，不能出现预览显示 A、实际启动 B。
- REST、MCP、daemon、web route 不允许各自复制优先级判断。

如果为了保持 API 兼容不能一次修改所有调用签名，可以先添加 `ProviderLaunchRequest`/`ResolvedProviderPlan` 作为内部对象，再在旧 command 边界做薄适配。不要继续给 `create_session` 增加离散参数。

### 7. Provider 数据模型

保留当前共享 Provider 存储，不要求照搬 CCPanel 的多张表；但共享模型必须能表达各 CLI 真正需要的信息。采用向后兼容的可选字段，至少评估并实现本轮实际需要的部分：

```text
Provider
  id                  稳定引用，重命名不变
  name                展示名
  providerType        协议/适配类型
  apiKey              可选密钥
  baseUrl             可选端点
  models[]            可选模型列表
    id
    label
    contextWindow     可选
    isDefault
  adapterOptions      CLI 特有且经过白名单验证的选项
```

CLI 特有字段不要塞成任意可执行字符串。允许的示例：

- Codex：`wireApi`、`supportsWebsockets`、能力提示。
- OpenCode：provider key、npm package、SDK options、模型 id。
- Grok：兼容配置类型、模型 id。
- Bedrock/Vertex：region、project/profile。

迁移要求：

- 老 `providers.json` 无新字段时可直接读取。
- 不改变既有 Provider id。
- 不丢弃未知但合法的旧字段；如果 serde 当前会丢弃，需要先评估是否真的存在扩展字段，再决定是否保留。
- 保存失败必须保留旧文件；继续使用现有原子写机制。
- 对名称、id、URL、API key、models 数量和每个字符串长度设合理上限，避免异常配置造成内存或 UI 问题。
- `__system__` 仍禁止作为真实 Provider 写入。
- 不要把 API key 放进前端持久化 store、launch history、session snapshot、日志或错误消息。前端表单可短暂持有输入值，但不得进入 localStorage/Zustand persist。

如果模型列表会让本轮风险失控，最低可接受方案是先保证双模式与 Provider 确实生效，并为模型字段保留兼容扩展点；但不得为了“支持模型”牺牲 Native 不干预和全入口一致性。

### 8. Adapter 契约

把 Provider 行为收口到 adapter，不要只靠 `Provider::to_env_vars()` 通用映射。建议为 adapter 增加或等价实现以下能力：

```rust
fn build_provider_injection(
    &self,
    plan: &ResolvedProviderPlan,
    runtime: LaunchRuntime,
) -> AppResult<ProviderInjection>;

struct ProviderInjection {
    env_set: HashMap<String, String>,
    env_remove: Vec<String>,
    args: Vec<String>,
    temp_files: Vec<ManagedTempFile>,
    remote_bootstrap: Option<...>,
}
```

硬约束：

- `Native` 必须返回 Provider 维度的空注入：`env_set=[]`、`env_remove=[]`、Provider args=[]、Provider temp files=[]。
- `Managed` 必须生成确定性注入，并清理同一 CLI 的冲突 Provider 变量。
- 密钥只能进入子进程环境、权限受限的会话临时文件或安全的远程传输通道，不能进入命令行参数。
- 日志可以写 `mode/cli/providerId/providerType/runtime`，不能写 key、token、完整 env、完整远程命令。
- adapter 返回的 Provider env 和现有 `extra_env` 合并时必须定义优先级。建议 Provider 计划先清冲突、再写 Provider 值，最后只允许经过白名单的 runner `extra_env`；若 `extra_env` 能覆盖密钥，必须明确这是受信入口并有测试。
- 临时配置按 session 隔离，文件名不可由未经处理的 Provider id 直接拼路径。
- 会话 close/kill、spawn 失败和应用退出都要 best-effort 清理临时 Provider 文件。

### 9. 各 CLI 的最低正确实现

#### 9.1 Claude Code

Managed：

- Anthropic/Proxy 使用已确认的 `ANTHROPIC_*` 变量。
- Bedrock/Vertex 使用各自官方开关与 region/project/profile。
- Managed 切换到 Anthropic/Proxy 时，清理会强制进入 Bedrock/Vertex 的冲突开关；切到 Bedrock/Vertex 时也要清理其他模式的冲突项。
- `ConfigProfile` 目录模式只适用于 Claude，使用 `CLAUDE_CONFIG_DIR`；JSON env 文件模式必须验证 key 和 value 类型、大小，不执行其中任何命令。

Native：

- 不设置/删除任何 `ANTHROPIC_*`、Bedrock、Vertex 或 `CLAUDE_CONFIG_DIR` Provider 变量。
- 不改用户 Claude settings/credentials 中的 Provider 内容。
- cc-switch 或 shell 当前环境应自然生效。

#### 9.2 Codex

Managed：

- 保留当前 per-launch `-c model_provider=...` 方案。
- 为选中 Provider 生成安全、稳定的 TOML key；正确转义 base URL、name、model。
- `model_providers.<id>.env_key` 指向 CC-Panes 专用环境变量，API key 不得出现在 `args`。
- 根据端点能力设置已验证的 `wire_api`，不要对所有第三方端点盲目假设；当前产品只支持 Responses 时，UI 和校验要明确。
- 可选模型通过 `-c model=...`；context window 等仅在用户/Provider 明确配置时覆盖。
- Local、WSL、SSH 生成等价的 Codex 配置覆盖，注意 shell/TOML 双层转义。

Native：

- 不生成 `model_provider`、`model_providers.*`、`model`、Provider context window 等覆盖。
- 不注入 CC-Panes Provider key。
- 不隔离/改写 `CODEX_HOME`，不改 `~/.codex/config.toml`，让 Codex 登录态、原生 Provider、resume 历史保持原样。
- 保留现有“不选择 Provider 时不产生 model_provider”的单测并扩大到 WSL/SSH command builder。

#### 9.3 OpenCode

Managed：

- 不要只依赖通用 `OPENAI_API_KEY`/`OPENAI_BASE_URL` 就宣称 Provider 已选中。
- 生成会话级 OpenCode 配置，明确 provider key、`options.apiKey`、`options.baseURL`、必要的 npm package 和 model。
- 配置应与用户原生配置按 OpenCode 的实际优先级合并；只覆盖本次 Provider/模型和 CC-Panes 自己拥有的 MCP/instructions/theme 键。
- 不覆盖用户其他 Provider、插件、模型或未知配置。
- Local、WSL、SSH 必须走等价的 adapter 逻辑。WSL/SSH 若需要远端临时文件，应在目标环境创建 mode 0600 的会话文件并清理，不能把 Windows 本地路径塞给远端 CLI。

Native：

- 不写 provider/model 键，不设置 Provider 专用 env。
- 验证 `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` 的使用不会遮蔽用户原生 Provider。若 OpenCode 对自定义配置是替换而非深合并，必须先读取并结构化合并用户配置，或把 CC-Panes 非 Provider 配置放到不会接管 Provider 的官方通道。
- 不永久改写用户的 `opencode.json`。

#### 9.4 Gemini CLI

Managed：

- 只使用当前 Gemini CLI 明确支持的认证与端点变量/配置。通过仓库已有研究、CLI `--help` 或官方资料核实，不要凭变量名猜测 base URL 支持。
- 支持 API key 和必要的 Google Cloud project/location 配置时，字段与 ProviderType 对齐。

Native：

- 不设置/删除 Gemini/Google Provider 变量，不改 Gemini 原生配置和登录态。

#### 9.5 Kimi CLI

Managed：

- 可以复用现有会话级 `--config-file` 方案，配置放在 CC-Panes 数据目录并按会话隔离。
- Provider、base URL 和 key 确实写入该会话配置，失败时不能静默转 Native。

Native：

- `providerSelection=none` 必须自动得到现有 `kimiConfigMode=native` 的不干预效果。
- 不传 `--config-file`，不设置 `KIMI_SHARE_DIR`，不设置 Kimi Provider env，让 CLI 使用自己的配置和数据目录。
- 旧 `kimiConfigMode` 仍需兼容，但不能与新的统一模式互相矛盾。出现矛盾时 `providerSelection=none` 优先保护 Native；`explicit` 优先保证 Managed，并输出非敏感诊断。

#### 9.6 GLM / Crush

Managed：

- 只有 Managed 时才允许生成/选择 CC-Panes 的 Crush 配置和数据目录。
- 注入经验证的 `ZAI_API_KEY`、`ZAI_BASE_URL` 或结构化配置。

Native：

- 不设置 `CRUSH_GLOBAL_CONFIG`、`CRUSH_GLOBAL_DATA`、`ZAI_*` Provider 变量，不强传 CC-Panes data dir。
- 让 `crush` 读取用户原生配置。若 session 追踪依赖隔离 data dir，必须把“会话数据隔离”与“Provider 配置接管”拆开，不能以追踪为由覆盖原生 Provider。

#### 9.7 Cursor CLI

Managed：

- 只注入 Cursor CLI 当前确认支持的凭证/端点配置。
- 不支持自定义 base URL 就不要在 UI 暴露一个无效输入框。

Native：

- 不设置/删除 Cursor Provider 变量，不改 Cursor 登录态。

#### 9.8 Grok CLI

Managed：

- 核实并采用当前 Grok CLI 真正识别的 API key、模型和代理 base URL 通道。
- 重点对照参考实现的 `GROK_MODELS_BASE_URL`、`GROK_CLI_CHAT_PROXY_BASE_URL` 和 `--model`，但以当前 CLI 行为为准。
- 如果某种 Provider 只能通过 `~/.grok/config.toml` 表达，生成会话级覆盖或做结构化、可回滚的最小合并；不得覆盖用户其他模型/MCP 配置。

Native：

- 不设置/删除 Grok Provider 变量，不添加 `--model`，不改用户 Grok Provider/模型配置。
- 现有 MCP 同步如果必须写 `~/.grok/config.toml`，只能拥有 `ccpanes` MCP 条目，必须备份、结构化合并且不触碰 Provider/model 表。

### 10. Local、WSL、SSH 一致性

不要让运行环境分支绕过 adapter。三种环境都消费同一个 `ResolvedProviderPlan` 和同一 adapter 生成的逻辑结果，只在“如何把结果送进子进程”这一层不同。

Local：

- 使用 `CommandBuilder` 的 env set/remove。
- 参数逐项传递，不拼 shell 字符串。
- 会话临时文件放 `AppPaths` 对应的 dev/release 数据目录。

WSL：

- Native 不应从 Windows 主动透传 Provider 变量；WSL 内 shell/CLI 自己的配置生效。
- Managed 在 WSL 内显式 `unset` 冲突变量后 `export` 选中值，或生成 WSL 内可访问的会话配置。
- 所有值使用现有可靠的 POSIX shell escape helper，不手写半套转义。
- Windows 路径要转换为 WSL 路径；不要假设 `C:\...` 在 Linux CLI 中可读。
- Codex/OpenCode/Kimi 等需要临时配置时，测试路径、权限和清理。

SSH：

- Native 不发送 Provider env/args/config，让远端账户自己的 shell 和 CLI 配置生效。
- Managed 必须在远端真正选择 Provider，而不是只把几个可能无效的 env 放在前缀。
- 不把 API key 打进 tracing、错误、launch history 或前端事件。
- 评估当前 `ssh ... 'export KEY=secret && ...'` 导致密钥出现在本机进程参数的风险。优先使用不会把 secret 放入本机 argv 的启动/bootstrap 通道；若受 PTY/SSH 限制无法安全完成，必须把该项标为上线阻断，不能假装“已支持 SSH Managed”。
- SSH resume 原有能力不得回归；Provider 参数与 resume 参数都要正确转义并同时生效。

### 11. 前端体验

使用现有 Launcher 和 Provider 管理组件，不新建重复启动器。

#### 启动器

- 三态选择文案要直白：
  - `inherit`：跟随运行配置
  - `explicit`：使用 CC-Panes Provider
  - `none`：使用 CLI 自带配置
- 只有 `explicit` 展示 Provider 下拉。
- Provider 下拉只展示当前 CLI 兼容项，并显示 Provider 类型；有模型时再显示模型下拉。
- CLI 切换后重新验证当前 Provider。若不兼容，清空选择并显示提示，不能保留一个不可见的旧 id。
- 没有兼容 Provider 时展示“先去 Provider 管理添加”，但 Native 仍可启动。
- 提交前阻止 `explicit + 未选 Provider`。
- 显示只读“本次实际配置”摘要：模式、来源、Provider、模型、运行环境。摘要来自后端 preview resolver，不能前端再猜一遍。

#### Provider 管理

- 保留按 CLI 的 Tab，但列表过滤应使用与 adapter capability 同源的数据。
- “系统/CLI 自带配置”条目在所有 CLI Tab 都可见；宿主探测结果只对 Local 有意义，WSL/SSH 明确显示“使用目标环境自身配置”，不要拿 Windows 的 Anthropic 探测结果判断其他 CLI 是否可用。
- Provider 卡片负责 CRUD、默认预选和测试配置，不恢复重复的“启动会话”大按钮。
- API key 默认掩码；复制、导出需显式操作和确认。
- 新增/编辑时只显示该 CLI/ProviderType 真正支持的字段。无效字段不保存。
- Provider 重命名不改变 id，历史/Workspace/Profile 引用不失效。

#### 错误和 i18n

- 所有新增用户文案同步加入 `web/i18n/locales/zh-CN` 和 `web/i18n/locales/en`。
- 错误必须区分：未选择、Provider 不存在、CLI 不兼容、配置无效、临时文件失败、远端注入失败。
- Toast/错误不能显示 API key、token、完整 env 或包含凭证的远程命令。

### 12. 全入口传播审计

逐项追踪并修复 `providerSelection`、`providerId`、`modelId` 的保存和恢复。不要以“全局启动器正常”作为完成依据。

前端入口至少审计：

- `web/components/launcher/*`
- Workspace/Project 启动与 `web/utils/workspaceLaunch.ts`
- `web/hooks/useOpenTerminal.ts`
- `web/stores/usePanesStore.ts`
- Pane `+`、Tab clone/duplicate、重新打开关闭的 Tab
- `web/components/home/HomeRecentProjects.tsx`
- Recent Launch、Quick Command、状态栏重启
- Resume/Session manager/应用启动后的 session restore
- Popup terminal
- Self Chat/CCChan 等内部发起的 CLI 会话

后端/API 入口至少审计：

- Tauri terminal commands
- `cc-panes-core/src/models/terminal.rs`
- `cc-panes-core/src/services/terminal_backend.rs`
- `src-tauri/src/services/orchestrator_service.rs` 的 MCP `launch_task`
- REST `launch_task`
- `cc-panes-web` terminal/history routes
- `cc-panes-daemon/src/server.rs`
- `cc-panes-ctl` 请求模型和代理边界
- Launch history、workspace snapshot、terminal session restore repository

规则：

- 新启动默认 `inherit`。
- 用户明确选择 Native 后，任何中间层都不能把它降级成字段缺失，再由后端重新 fallback 到 Provider。
- 用户明确选择 Managed 后，Provider id 和模型必须到达后端 resolver。
- History/snapshot 保存的是 mode、providerId、modelId 和非敏感展示信息，不保存 key/base URL 快照。
- Provider 被删除后恢复旧会话：Managed 应明确报“原 Provider 已不存在”并允许用户改选或切 Native，不能静默使用另一个默认 Provider。

### 13. 迁移和向后兼容

对旧数据采用以下保守规则，并用测试固定：

- 旧请求/记录有 `providerId`、没有 `providerSelection`：按 `inherit` 读取，保持“请求 providerId 优先”的既有效果。
- 旧请求/记录既无 `providerId` 也无 `providerSelection`：按 `inherit`；没有 Profile/Workspace 绑定时最终为 Native。
- `providerId == "__system__"`：归一为 `none`。
- 明确存过 `providerSelection == "none"`：永远保持 Native，不被默认 Provider 或 Profile 覆盖。
- 明确存过 `providerSelection == "explicit"` 但 Provider 已删除：返回可恢复错误，不自动换 Provider。
- 旧 Kimi `kimiConfigMode=native`：迁移/解析为 Native 行为；不要删字段导致旧 profile 反向变 Managed。
- 旧 ProviderType 别名继续可读，重新保存时写规范值。
- 不破坏 dev/release 数据目录隔离。

如需数据库 migration，遵循现有编号和幂等模式；`ALTER TABLE` 后补读取默认值和 repository 往返测试。

### 14. 安全审计硬要求

按 STRIDE 做一次本功能范围内的检查，并把结论放入最终回复：

- **Spoofing**：禁止伪造 `__system__` 真实 Provider；Provider id 必须存在且匹配类型。
- **Tampering**：结构化写 JSON/TOML，不用字符串替换用户配置；临时文件原子写；路径不得逃出允许目录。
- **Repudiation**：记录非敏感的 mode/cli/providerId/runtime/结果，足以排障；不记录 secret。
- **Information Disclosure**：检查 tracing、toast、命令预览、SSH argv、history、导入导出、备份文件、测试快照是否泄密。
- **Denial of Service**：限制 Provider、model、env 项数量及长度；拒绝超大配置文件。
- **Elevation of Privilege**：ConfigProfile 只能读取配置并向子进程注入字符串，不能执行文件里的命令；远端路径和 env key 必须校验。

额外要求：

- API key 不得出现在 CLI args。写测试遍历 `args` 和预览文本，断言不含测试 secret。
- 日志 helper 必须对 token/key/auth/header/query token 做统一脱敏。
- 会话临时凭证文件在 Unix/WSL/SSH 上权限为 0600；Windows 使用当前用户可访问的数据目录并避免宽松 ACL 扩散。
- 导出 Provider 时默认脱敏，包含密钥的导出必须显式选择并使用项目已有加密封装；没有安全封装就不要新增明文全量导出。
- 运行 `npm audit --audit-level=high`；Rust 有 `cargo audit` 时运行。依赖审计发现与本任务无关的问题只报告，不擅自升级整个依赖树。

### 15. 自动化测试

先写会失败的回归测试，再改实现。至少覆盖以下矩阵。

#### Resolver 单元测试

- `none + 任意 CLI + workspace/profile provider` -> Native，provider=None。
- `explicit + 合法兼容 Provider` -> Managed。
- `explicit + 空 id` -> InvalidArgument。
- `explicit + 不存在 id` -> NotFound。
- `explicit + 不兼容类型` -> IncompatibleProvider。
- `inherit + request provider` -> Managed，source=Explicit/Request。
- `inherit + profile provider` -> Managed，source=LaunchProfile。
- `inherit + 无绑定` -> Native。
- `__system__` -> Native。
- Plain shell + explicit Provider -> 拒绝。

#### 每个 adapter 的成对测试

每个已注册 CLI 至少有一组 Managed 正向测试和一组 Native 负向测试：

- Managed：预期 env/args/temp config 存在并正确。
- Native：Provider env_set/env_remove/args/temp config 全空，或明确断言不存在该 CLI 的 Provider key。
- secret 不在 args、日志预览和错误文本。
- 冲突变量只在 Managed 被移除。

重点回归：

- Codex Native 不含 `model_provider=`，不含 CC-Panes Provider secret env。
- Codex Managed 的 key 只在 env，args 只有 `env_key` 名称。
- OpenCode Native 配置合并后仍保留用户 Provider/model。
- OpenCode Managed 只覆盖选中 Provider，不丢用户其他键。
- Kimi Native 不生成 `--config-file` 和 `KIMI_SHARE_DIR`。
- GLM Native 不生成 `CRUSH_GLOBAL_CONFIG`/`CRUSH_GLOBAL_DATA`。
- Grok Managed 的 base URL 使用当前 CLI 真正识别的通道。
- Claude Managed 在 Anthropic/Bedrock/Vertex 间不会被父环境冲突变量劫持。

#### Runtime command builder 测试

对每个支持的 CLI 至少覆盖 Local；Claude/Codex/OpenCode/Kimi/GLM/Grok 还需覆盖 WSL 和 SSH 的 Managed/Native 关键断言：

- Native remote command 不含 Provider export/unset/模型覆盖。
- Managed remote command 有正确、转义后的非敏感配置。
- 测试 secret 不出现在可记录的 command preview；如果底层 argv 仍包含 secret，测试必须失败，推动改安全通道。
- WSL 临时配置使用 Linux 可读路径。

#### 前端测试

- CLI Tab/Launcher 只列兼容 Provider。
- 切换 CLI 会清除不兼容选择。
- `explicit` 未选择时不能提交。
- `none` 提交后保留为 `none`，不会带 providerId。
- preview 摘要与后端返回一致。
- Provider 删除后的 restore 显示可恢复错误。
- zh-CN/en 新增 key 对称。

#### 跨层测试

- Tauri request camelCase -> Rust struct -> resolver -> terminal adapter。
- MCP、REST、web、daemon 对同一输入得到相同 Provider plan。
- launch history/session restore round trip 保留 `none`、`explicit` 和 modelId。
- Local/WSL/SSH 同一 Managed Provider 的语义一致。

### 16. 手动验收矩阵

自动化通过后，在当前 Windows 主机做能做的桌面验证。每一项记录实际结果，不可验证的远端环境明确写“未验证”，不能写成通过。

外部请求边界：只有仓库中已有无计费测试账号，或用户明确指定了测试 Provider/测试凭证时，才能发真实 API 请求。不得自行读取并使用用户生产密钥，不得把真实对话、源码或会话历史发送到第三方端点。没有获准的测试凭证时，用 command builder、mock server 或本地可控假端点完成验证，并把真实连通性列为未验证。

每个已安装 CLI 至少执行：

1. Native 启动，确认 CLI 显示/使用原生 Provider 或登录态。
2. Managed 启动，选择一个测试 Provider，确认请求实际到达选中端点。
3. 在两种模式间各新建一次会话，确认互不污染。
4. 关闭并重新启动 CC-Panes，再从 Recent/Resume 恢复，确认 mode 不变。
5. 切换 CLI 后确认 Provider 列表改变且不存在跨 CLI 脏选择。

重点场景：

- Claude Native + cc-switch 当前配置。
- Claude Managed Proxy。
- Codex Native + 现有 `~/.codex/config.toml`。
- Codex Managed OpenAI-compatible Provider。
- OpenCode Native + 原有 provider/model。
- OpenCode Managed + 自定义 base URL/provider key。
- Kimi Native 不出现 CC-Panes share/config 重定向。
- GLM Native 使用用户自己的 Crush 配置。
- Grok Managed 代理端点和模型确实生效。
- WSL 中 Native 读取 WSL 自己的配置，不读取 Windows Provider。
- SSH 中 Native 读取远端配置；Managed 密钥不出现在本机进程命令行/日志。

### 17. 必跑命令

根据改动范围先跑定向测试，再跑完整门禁：

```powershell
npx tsc --noEmit
npm run build
npm run test:run -- --maxWorkers=3
cargo fmt --all -- --check
cargo check --workspace
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

再做静态泄密扫描，按实际测试 secret 扩充：

```powershell
rg -n "API_KEY|AUTH_TOKEN|Bearer|apiKey|api_key" web cc-cli-adapters cc-panes-core src-tauri
rg -n "providerSelection|provider_selection" web cc-panes-core src-tauri cc-panes-web cc-panes-daemon cc-panes-ctl
```

扫描结果不能机械判错；逐处确认是否只出现变量名/类型，还是会输出真实值。

### 18. 禁止的错误修法

- 只在 Launcher 下拉里加“自带”选项，后端仍然 fallback 到默认 Provider。
- 用 `providerId?: string` 的有无代替三态，导致 `inherit` 与 `none` 再次混淆。
- Native 模式通过删除所有 `*_API_KEY` 实现；这会破坏用户原生环境。
- Managed 模式只加 `OPENAI_BASE_URL`，却不显式选择 Codex/OpenCode Provider。
- 为了隔离而修改 `CODEX_HOME`、`HOME` 或整个 CLI 配置目录，导致登录态和 resume 丢失。
- 永久覆盖 `~/.codex/config.toml`、OpenCode 配置、Kimi/Crush/Grok 配置。
- Local 修好，WSL/SSH 继续走另一套旧逻辑。
- 前端过滤不兼容 Provider，但后端不校验。
- Provider 找不到时告警后继续启动 Native，让用户误以为 Managed 生效。
- 把 API key 放进 `-c` 参数、SSH command string、日志、history 或错误消息。
- 复制 CCPanel 的巨型 ProviderManager 组件和多套重复 CRUD，而不适配 CC-Panes 的 service/store/adapter 架构。
- 为通过测试删除或放宽已有 Native 不干预断言。

### 19. 完成定义

以下条件全部满足才能声明完成：

- 八种一等 CLI 都有明确的 Managed/Native 行为和 adapter 测试。
- Local/WSL/SSH 对支持组合使用同一 Provider resolver；不支持组合明确拒绝。
- 所有启动、恢复和远程 API 入口传播 `providerSelection`，不存在静默 fallback。
- Native 模式不干预 CLI 自带 Provider；Managed 模式能确定性选中 CC-Panes Provider。
- Provider/CLI 兼容性前后端一致，后端是最终守门人。
- API key 不进入 args、日志、history、snapshot。
- 老 providers、history、session restore 数据可读且行为不突变。
- TypeScript、build、前端测试、fmt、cargo check、clippy、Rust 测试全部通过。
- Windows 手动验收有真实证据；没有环境的 WSL/SSH/CLI 项明确列为未验证。
- `git diff --check` 通过；`git status --short` 只包含本任务文件和用户原有改动。

### 20. 最终回复格式

不要只说“已修复”。最终回复必须包含：

1. 根因：列出实际确认的跨层问题，不复述假设。
2. 实现：按 resolver、数据模型、adapter、runtime、UI、持久化说明。
3. 兼容保证：逐条说明 Native 为什么不会被 CC-Panes Provider 接管。
4. CLI 矩阵：八种 CLI 的 Managed/Native/Local/WSL/SSH 状态。
5. 安全审计：STRIDE 发现、已修复项、残余风险。
6. 验证证据：每条命令、退出码、测试数量或关键输出。
7. 未验证项：仅列真实未验证内容和原因。
8. 文件清单：只列本任务修改文件。

开始执行。先读取目标仓库规范与当前 diff，建立失败测试和统一 Provider resolver，然后完成实现，不要停在计划阶段。
