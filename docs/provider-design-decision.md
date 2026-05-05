# Provider 设计分析与决策

日期：2026-05-02
状态：草案
范围：CC-Panes Provider、MCP、Skill 的一体化运行配置与继承规则

## 当前结构

CC-Panes 目前已经有三类会影响 CLI 启动行为的配置：

- Provider：决定认证、API base URL、云厂商或代理。
- MCP：决定本次启动注入哪些 MCP server。
- Skill：决定本次启动注入哪些内置或项目级技能。

这三者本质上都属于“启动运行环境”。但它们的产品语义并不完全相同：

- Skill/MCP 更像 workspace 的工作方式，可以按项目需求自由组合并长期绑定。
- Provider 更像本次启动使用的账号/API 通道，workspace 可以有默认值，但打开时也应该允许用户选择合适的 Provider。

当前代码里它们已经部分聚合在 Launch Profile 中。中文产品文案统一称为“运行配置”，英文/API/代码层继续沿用 Launch Profile。Workspace 仍然单独保存 `providerId` 和 `launchProfileId`，导致 Provider 与 MCP/Skill 的职责边界不够清晰。

现状可以拆成四层：

| 层级 | 数据来源 | 职责 |
|---|---|---|
| Provider 源数据 | `providers.json` | 保存 Provider 列表、类型、密钥、base URL、默认标记 |
| Workspace 绑定 | `workspaces/<workspace>/workspace.json` | 目前同时保存 `providerId` 和 `launchProfileId` |
| Launch Profile | `launch-profiles.json` | 保存 Profile 级 `providerId`、MCP 策略、Skills 策略，已经接近“一体化运行配置” |
| 启动运行时 | `TerminalService` + `ProviderService` + CLI adapters | 解析 Provider，并为本地、SSH、WSL 启动注入运行时环境 |

关键实现文件：

- `cc-panes-core/src/models/provider.rs`
- `cc-panes-core/src/services/provider_service.rs`
- `cc-panes-core/src/services/terminal_service.rs`
- `cc-cli-adapters/src/*`
- `web/types/provider.ts`
- `web/utils/workspaceLaunch.ts`
- `src-tauri/src/services/orchestrator_service.rs`

## 已发现的问题

1. Provider、MCP、Skill 没有被当成同一个运行配置处理。

   目前 Launch Profile 已经包含 `providerId`、MCP 策略、Skill 策略，但 workspace 上仍然有独立 `providerId`。这会造成两个问题：

   - Provider 与 MCP/Skill 的继承规则不同。
   - 启动时需要同时判断 workspace provider 和 launch profile provider，逻辑容易分叉。

2. Workspace 缺少“自由组合 Skill/MCP”的明确产品模型。

   用户实际需要的是：每个 workspace 根据项目类型自由组合 Skill 和 MCP。例如一个 Rust workspace 可以启用 Rust 相关技能和本地文档 MCP，一个前端 workspace 可以启用浏览器、设计、截图相关能力。这些组合应属于 workspace 的稳定配置，而不是每次启动都重新选择。

3. Provider 需要作为打开时可选项。

   Workspace 可以有默认 Provider，也可以继承原始 CLI 配置或 CC-Panes 全局 Provider。但用户打开终端或启动 CLI 时，应能临时选择本次使用哪个 Provider。这个选择属于显式覆盖，应高于 workspace 默认值。

4. Provider 缺少明确的别名/重命名语义。

   Provider 底层应依靠稳定 `id` 进行引用；用户应能自由修改显示名或自定义别名，例如“公司 Claude”、“个人 OpenAI”、“硅基流动-备用”。重命名不应导致 workspace、history、profile 引用失效。

5. Provider 解析规则没有集中。

   `TerminalService` 目前按 `provider_id.or(profile_provider_id)` 解析 Provider，导致 workspace 级 Provider 绑定不会参与普通终端启动。但文档、UI badge、MCP `launch_task` 的行为都暗示 workspace Provider 绑定应该生效。

6. Preview 与实际启动优先级不一致。

   `LaunchProfileService::resolve_profile` 当前更偏向 Profile Provider：

   ```text
   profile provider > request provider > workspace provider
   ```

   这会导致 UI Preview 与用户显式选择的启动 Provider 不一致。

7. REST 与 MCP `launch_task` 行为不一致。

   MCP `launch_task` 会根据 `workspace_name` 解析 workspace path 和 Provider 上下文。REST `handle_launch_task` 当前直接使用请求字段，没有应用同样的 workspace fallback。

8. WSL Provider 注入不完整。

   本地模式通过 PTY 环境变量注入 Provider。SSH 模式会在远端命令前 `export` Provider 变量。WSL 启动脚本主要导出 CC-Panes/MCP 上下文，没有一致地把 Provider 环境变量导入目标 distro。

9. CLI Adapter 能力声明与 `ProviderType` 不完全对齐。

   部分 adapter 暴露了历史值或不存在的 Provider 类型，例如 `openai`、`openrouter`、`custom`。实际前后端 Provider 类型包括 `open_ai`、`proxy`、`config_profile` 等。

## 决策

Provider、MCP、Skill 应统一纳入一个“运行配置”概念。现有 Launch Profile 就是这个概念的英文/API/代码名称；中文产品文案统一叫“运行配置”：

```text
运行配置 = Provider + MCP Policy + Skill Policy
```

Workspace 的稳定配置应重点表达 Skill/MCP 组合，同时保留一个默认 Provider 或继承 Provider。打开时用户可以选择 Provider 作为本次启动的显式覆盖。

更合理的模型是：

```text
原始 CLI 配置 / 用户环境 / CC Switch live config
  -> CC-Panes 全局增量运行配置
  -> Workspace 运行配置
    -> 本次启动显式覆盖
```

其中：

- 一个 workspace 同一时刻只有一个有效 Provider。
- Workspace 可以自由组合 Skill 和 MCP，形成适合当前项目的稳定工作方式。
- Workspace 可以从原始 CLI 配置和 CC-Panes 全局增量运行配置继承 Provider、MCP、Skill。
- Workspace 也可以只覆盖其中一部分，例如只覆盖 Skill/MCP，Provider 继续继承原始 CLI 配置或 CC-Panes 全局增量配置。
- 打开终端或启动 CLI 时，可以选择合适的 Provider；该 Provider 是本次启动显式覆盖。
- Provider 支持用户自定义显示名/别名，所有引用仍使用稳定 `id`。

短期为了兼容现有数据结构，Provider 启动解析规则先统一为：

```text
显式 providerId > Launch Profile providerId > Workspace providerId
```

终端启动时不 fallback 到全局默认 Provider。

中长期目标应演进为：

```text
显式运行配置覆盖 > Workspace 运行配置 > CC-Panes 全局增量运行配置 > 原始 CLI 配置
```

决策理由：

- 用户显式选择的 Provider 必须最高优先级，否则从 Provider 面板启动也可能被 Profile 覆盖。
- Provider、MCP、Skill 属于同一类“启动运行环境”，应使用同一套继承和覆盖框架。
- Skill/MCP 是 workspace 可长期组合的能力集。
- Provider 是本次启动实际使用的 API 通道，workspace 可以有默认值，但打开时必须允许选择。
- Workspace 应能拥有自己的默认 Provider，但这个 Provider 应是 workspace 运行配置的一部分，而不是一条独立旁路字段。
- 原始 CLI 配置是用户已有登录态、shell 环境、CC Switch live config 等外部状态，CC-Panes 默认尊重它。
- CC-Panes 全局运行配置只做增量叠加，例如添加全局 MCP、Skill 或用户显式设置的全局 Provider。
- 全局默认 Provider 不应脱离运行配置单独隐式注入，否则可能意外替换用户本机 CLI 登录态。

## 实现方向

1. 明确运行配置模型。

   以现有 Launch Profile 为基础，把它定位为“运行配置”。命名规则固定为：

   ```text
   中文产品文案：运行配置
   英文产品文案/API/代码：Launch Profile
   ```

   结构上仍是：

   ```text
   Launch Profile
   - providerId
   - mcpPolicy
   - skillPolicy
   ```

   底层继续复用现有 `launch-profiles.json`、`launchProfileId`、`LaunchProfileService` 等命名，避免不必要的大规模重命名。

2. Workspace 绑定一个运行配置。

   Workspace 应最终只绑定一个运行配置，而不是长期同时维护 `providerId` 与 `launchProfileId`。该运行配置至少表达三件事：

   - 这个 workspace 启用哪些 Skill。
   - 这个 workspace 启用哪些 MCP。
   - 这个 workspace 默认使用哪个 Provider，或是否继承原始 CLI 配置 / CC-Panes 全局 Provider。

   兼容期内：

   - `workspace.launchProfileId` 优先表示 workspace 使用的运行配置。
   - `workspace.providerId` 作为旧数据兼容字段，等价于“workspace 运行配置中的 provider override”。
   - 新 UI 应引导用户配置 workspace 运行配置，而不是单独配置 Provider。

3. 支持从原始 CLI 配置和 CC-Panes 全局增量运行配置继承。

   继承底座分两层：

   ```text
   原始 CLI 配置 / 用户环境 / CC Switch live config
   CC-Panes 全局增量运行配置
   ```

   原始 CLI 配置包括用户已经配置好的 Claude/Codex/Gemini/OpenCode live config、shell 环境变量、登录态，以及 CC Switch 等外部工具写入的当前配置。CC-Panes 不接管这层，只尊重它。

   CC-Panes 全局增量运行配置用于补充 CC-Panes 自己的全局能力，例如全局 MCP、全局 Skill、默认启动策略，或者用户显式设置的全局 Provider。

   Workspace 运行配置可以按 section 继承或覆盖：

   ```text
   provider: inherit | override(providerId)
   mcpPolicy: inherit | override(policy)
   skillPolicy: inherit | override(policy)
   ```

   第一阶段可以先不改 schema，只在文档和解析规则中确认方向；第二阶段再引入显式 inherit/override 结构。

4. 打开时支持选择 Provider。

   UI 上，打开 workspace/project/terminal 时应能选择本次 Provider：

   ```text
   使用 Workspace 默认 Provider
   使用 CC-Panes 全局 Provider
   使用指定 Provider
   不注入 Provider，使用 CLI 自身登录态
   ```

   选择“指定 Provider”时，传入 `providerId`，按显式覆盖处理。选择“不注入 Provider”需要有明确语义，避免被 workspace/default fallback 再次注入。

   “不注入 Provider”语义固定为：

   ```text
   CC-Panes 不注入 Provider env
   CC-Panes 不主动清理已有 Provider env
   CLI 继续使用自身 live config、登录态、用户 shell 环境或 CC Switch 当前配置
   ```

   第一阶段不做强制 `env_remove`，因为清理环境变量可能破坏用户 shell 配置和 CC Switch 兼容性。

   右键点击 workspace 是最重要的启动入口之一，必须按同一套规则实现：

   - Workspace 右键菜单应展示当前 workspace 的运行配置摘要，例如默认 Provider、启用的 MCP、启用的 Skill。
   - Workspace 右键启动 Claude/Codex/Gemini 等 CLI 时，默认使用 workspace 运行配置。
   - Workspace 右键菜单应提供 Provider 选择入口，允许本次启动临时切换 Provider。
   - 如果用户选择“不注入 Provider”，本次启动必须显式跳过 provider fallback，使用 CLI 自身登录态。
   - Project 右键、Recent Launch、Provider 面板启动、MCP/REST `launch_task` 都应复用同一套启动解析逻辑，不能各自拼接 providerId。

5. Provider 支持重命名和别名。

   Provider 的稳定引用使用 `id`，显示使用用户可编辑名称：

   ```text
   id: 稳定，不随重命名变化
   name: 用户可编辑显示名
   alias: 可选，用于 workspace 或 UI 场景下的自定义别名
   ```

   第一阶段可以复用现有 `name` 字段满足“重命名”。若需要同一个 Provider 在不同 workspace 下显示不同名称，再引入 workspace 级 alias 映射。

6. 在后端集中解析 effective provider。

   启动路径中统一解析一个 `effective_provider_id`：

   ```text
   explicit_provider_id
     .or(profile.provider_id)
     .or(workspace.provider_id)
   ```

   解析结果统一用于：

   - `ProviderService::get_env_vars`
   - `CliAdapterContext.provider`
   - 需要记录 resolved provider 时的 launch history 和 orchestrator event metadata

7. 对齐 Launch Profile Preview。

   将 `LaunchProfileService::resolve_profile` 的 Provider 优先级调整为：

   ```text
   request providerId > profile providerId > workspace providerId
   ```

8. 对齐 REST 与 MCP 编排入口。

   让 REST `handle_launch_task` 与 MCP `launch_task` 保持一致：

   - 根据 `workspace_name` 解析 workspace 元数据。
   - 请求未传 `workspacePath` 时使用 workspace path。
   - 由统一 Provider resolver 处理显式、Profile、Workspace 的优先级。
   - 可用时在 launch event 中带上 resolved provider metadata。

9. 补齐 WSL Provider 环境变量导出。

   WSL 启动脚本只导出 Provider 环境变量和必要的 CC-Panes 上下文，不导出整套宿主机环境。

   示例：

   ```bash
   export ANTHROPIC_API_KEY='...'
   export ANTHROPIC_BASE_URL='...'
   exec claude ...
   ```

10. 修正 CLI Adapter 能力值。

   Adapter 的 `compatible_provider_types` 应使用真实 `ProviderType` 值：

   - Claude: `anthropic`, `bedrock`, `vertex`, `proxy`, `config_profile`
   - Codex: `open_ai`
   - Gemini: `gemini`
   - Kimi: `kimi`
   - GLM: `glm`
   - OpenCode: `opencode`，仅在确认支持后再加入 `open_ai` 或 `anthropic`

## 开始实现前必须补齐的决策

1. Provider 选择需要显式状态，而不是只靠 `providerId?: string`。

   现有 `providerId` 只能表达“指定某个 Provider”或“没有传”。但后续至少需要区分四种状态：

   ```text
   inherit_workspace: 使用 Workspace 运行配置
   inherit_global: 使用 CC-Panes 全局增量运行配置；若无 Provider，则继续尊重原始 CLI 配置
   explicit(providerId): 使用指定 Provider
   none: 不注入 Provider，也不清理已有 Provider env，使用 CLI 自身登录态、用户环境或外部工具管理的 live config
   ```

   因此实现时需要新增类似 `providerSelection` 的请求字段，或在后端内部引入等价结构。否则“不注入 Provider”会被 workspace/global fallback 覆盖，无法稳定实现。

2. 运行配置命名已经定稿。

   中文统一叫“运行配置”，英文/API/代码层继续叫 Launch Profile。实现时不需要重命名现有 `launchProfileId`、`LaunchProfileService`、`launch-profiles.json`。

3. 原始 CLI 配置与 CC-Panes 全局增量来源已经定稿。

   继承来源不是一个完全由 CC-Panes 接管的新全局配置，而是：

   ```text
   原始 CLI 配置 / 用户环境 / CC Switch live config
     + CC-Panes 全局增量运行配置
   ```

   也就是说，CC-Panes 默认继承用户原先 CLI 的配置，然后只叠加 CC-Panes 自己明确管理的全局 MCP、Skill、启动策略，或用户显式设置的全局 Provider。

4. Workspace 配置入口需要定稿。

   Workspace 至少需要两个入口：

   - Workspace 设置页：编辑该 workspace 的默认 Provider、MCP、Skill 组合。
   - Workspace 右键菜单：快速查看配置摘要，并在本次启动时临时选择 Provider。

5. Provider 重命名的第一阶段语义需要定稿。

   第一阶段建议直接复用现有 `Provider.name` 作为用户可编辑显示名。所有引用继续使用稳定 `Provider.id`。workspace 级 alias 映射暂不实现，避免先引入额外 schema。

6. 启动历史的 Provider 记录语义需要定稿。

   History 应记录本次启动实际使用的 Provider 状态：

   ```text
   providerSelection
   resolvedProviderId
   resolvedProviderName
   ```

   这样历史恢复时可以区分“当时显式指定 Provider”和“当时继承 workspace 默认 Provider”。

## CC Switch 兼容策略

CC Switch 也是 Provider/MCP/Skill/Prompt 管理工具，并且会管理多个 CLI 的 live config。根据公开文档，它的核心数据在 `~/.cc-switch/`，包括 SQLite 数据库和 skills 目录；它会把配置写回各 CLI 的实际配置文件，例如 Claude 的 `~/.claude/settings.json`、Codex 的 `~/.codex/auth.json` / `config.toml`、Gemini 的 `~/.gemini/.env`、OpenCode 的配置目录。

为了避免和用户已安装的 CC Switch 冲突，CC-Panes 的原则应是：

1. 默认不接管、不改写 CC Switch 的 source of truth。

   CC-Panes 不应直接读写 `~/.cc-switch/cc-switch.db`，也不应把 `~/.cc-switch/` 当成自己的 Provider 存储。`providers.json` 仍是 CC-Panes Provider source of truth。

2. 不主动改写 CLI 的 live config。

   CC Switch 的切换模型依赖写入各 CLI 的 live config。CC-Panes 如果也去改写 `~/.claude/settings.json`、`~/.codex/auth.json`、`~/.gemini/.env` 等文件，就会造成双写冲突。

   因此 CC-Panes Provider 启动应优先采用“本次进程环境注入”：

   ```text
   CC-Panes 选择 Provider -> 只影响本次 PTY/SSH/WSL 启动进程
   CC Switch 当前 live config -> 保持不变
   ```

3. “不注入 Provider”就是 CC Switch 兼容模式。

   如果用户已经用 CC Switch 切好了当前 CLI 的 Provider，那么 CC-Panes 启动时选择“不注入 Provider”，就应完全尊重 CLI 当前 live config 和登录态。

   这也是为什么 `providerSelection = none` 必须是显式状态，不能等同于 `providerId = null`。该模式只是不注入，不会主动清理已有环境变量。

4. `config_profile` 只做兼容读取，不默认写回。

   现有 `config_profile` 已支持两类路径：

   - Claude 配置目录：通过 `CLAUDE_CONFIG_DIR` 指向独立目录。
   - JSON 文件：读取 `{ "env": { ... } }` 形式的环境变量配置。

   后续应保持这个方向：可以导入或引用 CC Switch/ccswitch 风格的 env profile，但默认不修改外部工具生成的配置文件。

5. 可以做“检测与提示”，不能静默接管。

   如果检测到 `~/.cc-switch/` 或常见 CC Switch live config，UI 可以提示：

   ```text
   检测到 CC Switch。你可以选择：
   - 不注入 Provider，沿用 CC Switch 当前配置
   - 导入当前 live config 为 CC-Panes Provider
   - 为本次启动显式选择 CC-Panes Provider
   ```

   任何导入都应是复制式导入，不应建立隐式双向同步。

6. MCP/Skill 同样避免双写。

   CC Switch 也能管理 MCP 和 Skills。CC-Panes 的 workspace 运行配置可以管理自己的 MCP/Skill 注入，但不应直接覆盖 CC Switch 的数据库或 live files。若要兼容，优先提供导入/引用，而不是双向同步。

## 非目标

- 本轮不迁移 `providers.json`。
- 本轮不立即重写 Provider 数据模型。
- 本轮不立即迁移 `workspace.providerId`，只先按兼容字段处理。
- 本轮不立即引入显式 inherit/override schema，先确定方向和解析优先级。
- 本轮不立即实现 workspace 级 Provider alias 映射，先明确 `name` 作为可编辑显示名。
- 本轮不直接读写 `~/.cc-switch/cc-switch.db`。
- 本轮不主动改写由 CC Switch 管理的 CLI live config。
- 本轮不把密钥迁移到系统 keychain。
- 不把全局默认 Provider 隐式注入到每次 CLI 启动。
- 不在 `providerSelection = none` 时主动清理用户已有 Provider 环境变量。
- 不从 WSL 或非 Windows 环境声称 Windows desktop 行为已验证。

## 验证计划

当前环境可验证：

- Rust 单测覆盖运行配置中的 Provider 优先级解析。
- Rust 单测覆盖 Provider 缺失时的行为。
- Rust 单测覆盖 Launch Profile Preview 优先级。
- REST/MCP 测试覆盖 workspace Provider fallback。
- TypeScript 测试覆盖 workspace/project launch options 只保留显式 Provider，不伪造 workspace Provider。
- TypeScript 测试覆盖打开时指定 Provider 可覆盖 workspace 默认 Provider。
- TypeScript/Rust 测试覆盖 `providerSelection = none` 时不触发 workspace/global fallback。
- TypeScript 测试覆盖 Provider 重命名不改变 `id`，引用仍然有效。
- 测试覆盖 `config_profile` 读取 `{ "env": { ... } }` 时不会写回源文件。

需要 Windows 宿主机验证：

- WSL Claude Provider 环境变量注入。
- WSL Codex Provider 环境变量注入。
- Windows Tauri desktop 启动。
- WebView2 与 PTY 启动行为。
- 如果间接受影响，再验证全局快捷键、托盘、截图流程。

## 假设

- Workspace 绑定的 Provider 应在没有显式 Provider、也没有 Profile Provider 时影响启动。
- Launch Profile Provider 应覆盖 Workspace Provider。
- 显式 Provider 选择应覆盖 Profile 与 Workspace Provider。
- Provider、MCP、Skill 应作为一个整体运行配置进行继承和覆盖。
- 一个 Workspace 同一时刻只有一个有效 Provider。
- 每个 Workspace 可以自由组合 Skill/MCP。
- 打开时可以选择本次使用的 Provider，并作为显式覆盖。
- 打开时可以明确选择“不注入 Provider”，用于尊重 CLI 自身登录态、用户 shell 环境或 CC Switch 当前配置。
- “不注入 Provider”只是不注入，不主动清理已有环境变量。
- Provider 显示名/别名由用户自定义，底层引用使用稳定 `id`。
- 原始 CLI 配置是继承底座，CC-Panes 全局运行配置只做增量叠加。
- 全局默认 Provider 不应作为独立旁路参与运行时 fallback；它应属于 CC-Panes 全局增量运行配置的一部分。
- 本阶段 `providers.json` 仍是 Provider 的 source of truth。
