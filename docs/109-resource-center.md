# 109 · 资源中心：按启动档统一管理 MCP、Skills、Hooks

> 状态：**Proposal + Design（评审中）**（2026-11-02，基线 `feat/session-cost-status@0052ddb9`）。
> 参照：magpie `a3768cd` 的 Library 页（`docs/subsystems/library.md`、`mcp-router.md`，`internal/gui/assets/plugins/library/client.js`）。
> 前置阅读：`docs/97-skill-market.md`、`docs/103-ccpanes-mcp-slimming.md`。
> 命名：`docs/108` 的“资料空间”指素材与作品，本文不用“资料库”一词，沿用 i18n 里已有的模块名“资源中心”。

---

## 0. 结论先行

| 问题 | 答案 |
|---|---|
| 做什么 | 一个资源中心页，三个 tab（MCP、Skills、Hooks），每行资源末尾是一排**启动档开关** |
| 借鉴什么 | magpie 的“条目 × 使用方”交互，以及它的状态表达和粘贴添加 |
| 不借鉴什么 | magpie 把配置写进 CLI 主目录的做法。cc-panes 继续**按会话注入** |
| 分几期 | 一期：框架 + MCP；二期：Skills；三期：Hooks |
| Hooks 首批支持 | **Claude Code、Codex、Grok Build、OpenCode、Pi**。五者都有按会话入口，验证程度不同，详见第 2 节 |

---

## 1. Proposal

### 1.1 问题

1. **入口分散。** 同一类资源分布在多处：
   - MCP：`SharedMcpSection`（设置页、启动档卡片内）、`ProjectMcpSection`（标签页）、`LaunchProfileMcpCard`。
   - Skills：`WorkspaceSkillsHub`、`LinkSkillManager`、`GlobalSkillsPanel`、`SkillMarketPage`、`LaunchProfileSkillCard`。
2. **看不出“这个资源给了谁”。** 启动档决定注入内容，但现有界面只能进入某个启动档看它选了什么，不能从资源反查。
3. **MCP 添加成本高。** 现在要分字段填表，而大多数 server 的 README 给的是一段 JSON。
4. **Skill 更新状态不透明。** 用户看不出哪些有更新、哪些本地改过（`skill_remote_update_service.rs` 里没搜到本地改动检测，实现前再确认）。
5. **没有用户自定义 Hooks。** 现有 hook 都是内置项（上下文注入、Plan 归档等），用户不能增加自己的命令。

### 1.2 目标

- 在一个页面看清并修改“每个资源被哪些启动档使用”。
- 粘贴 JSON 即可添加 MCP。
- Skill 的更新和本地改动状态可见，更新不会悄悄覆盖本地修改。
- 用户能定义 Hook，并按启动档启用，且不写入 CLI 主目录。

### 1.3 非目标

- 不写 `~/.claude`、`~/.codex` 等 CLI 主目录。
- 本文不做：MCP 路由、MCP 工具列表和单工具开关、指令集和子代理管理、跨机器同步。这些留作后续提案。
- 三期首版只支持 Claude Code、Codex、Grok Build、OpenCode、Pi（各自须通过第 4 节的补验证），不支持其他 CLI 的自定义 Hooks，也不支持 WSL 和 SSH 启动。
- 首版 Hook 不支持导入和分享。

### 1.4 验收标准

- [ ] 三类资源都能在资源中心按启动档开关，结果与启动档编辑页一致，因为两边读写同一份策略。
- [ ] 改动只影响下次启动，界面明确说明；运行中的会话不受影响。
- [ ] 无法启用的开关点击后说明原因，且原因在页面上直接可读，不依赖 tooltip（移动端同样可用）。
- [ ] 能粘贴 `mcpServers` 格式的 JSON 批量添加 MCP，同名时不会静默覆盖。
- [ ] 启用自定义 Hook 后，CLI 主目录下的文件无变化，同项目的其他启动档会话也不触发该 Hook。
- [ ] 旧启动档配置无需迁移即可加载，自定义 Hook 默认全部关闭。
- [ ] 通过前端 `noRawText`、`lineRatchet` 基线检查和 Rust-TS 桥接一致性检查。

---

## 2. Hooks 按会话注入：验证结果

2026-11-02 调研。“实测”指本机一次性无头运行，Hook 只向临时目录写标记文件；“源码”指读了上游代码但没运行。

| CLI | 按会话入口 | 依据 | 结论 |
|---|---|---|---|
| Claude Code 2.1.316 | `--settings`，与项目配置**合并** | 实测 SessionStart、Stop 和合并 | **可行** |
| Codex 0.166.0 | `-c hooks.<Event>=…` + `-c hooks.state={…}` 按会话预置单条信任 | 实测 SessionStart、Stop 触发，`config.toml` 无变化 | **可行**，见 2.1 |
| OpenCode 1.17.11 | `OPENCODE_CONFIG_CONTENT`、`OPENCODE_CONFIG_DIR` 加载 JS 插件 | 实测插件加载和 session 事件；提示词因免费模型版本限制未到达模型，工具事件未验证 | **很可能可行**，需生成插件包装层 |
| Pi 1.5.0 | `-e`/`--extension <path>` | 官方文档；隔离目录实测扩展加载。无 Provider，事件未触发 | **很可能可行**，需生成扩展包装层 |
| Grok Build | `--plugin-dir <DIR>`，插件含 `hooks/hooks.json` | 源码（`xai-grok-pager/src/app/cli.rs`）注释写明始终受信任；本机未安装，**未运行** | **很可能可行**，待确认发布版有此参数 |

不在首批：Kimi（`--config-file` 能否带 `[[hooks]]` 文档未说明）、Gemini（`GEMINI_CLI_SYSTEM_SETTINGS_PATH` 有替换系统配置的风险）、Cursor（未发现按会话入口）。Copilot CLI、Qwen Code 没有 cc-panes 适配器。

#### 2.1 Codex 的信任方案

Codex 只运行已信任的 Hook，这也是最初两次 `-c` 测试没有触发的原因。

| 方案 | 结论 |
|---|---|
| `--dangerously-bypass-hook-trust` | **不采用**。它作用于本次调用的所有 Hook，包括仓库自带、用户没审查过的 Hook |
| 写入 `~/.codex/config.toml` | **不采用**。违反非目标 |
| `-c hooks.state` 预置单条信任 | **采用**。上游 `hook_states_from_stack` 读取 User 和 SessionFlags 两层的 `hooks.state` |

实现要点：

- Key 形如 `/<session-flags>/config.toml:session_start:0:0`，即 `来源:事件:分组下标:处理器下标`。
- 值是 `sha256:…`，由 Hook 规范化后的定义计算（`hook_hash`、`version_for_toml`）。本次从 `codex app-server` 的 `hooks/list` 读取 `currentHash`。
- `hooks.state` **必须用整表形式传入**。点号路径写法（`hooks.state."…config.toml…".trusted_hash=`）那次运行没有产出任何结果，推测是 Key 里的点号造成的，未深究。

风险：

- **这不是公开接口。** 官方文档没写 Key 和 Hash 规则，Codex 升级可能改变。Hash 对不上时 Hook 不会运行（失败安全），但用户 Hook 会静默失效，所以启动后要校验并在界面提示。
- **Hash 的取得方式待定。** 自行计算要复刻规范化逻辑，启动时查询 `hooks/list` 会增加启动耗时。优先走查询并缓存，以 Hook 定义和 Codex 版本为缓存键。
- **信任来自 cc-panes 的确认。** 这绕过了 Codex 自身的 `/hooks` 审查，所以 3.6 的“完整命令确认”不能省。
- **隔离性证据不完整。** 配了仓库 `.codex/hooks.json` 的对照测试里，只有预置信任的 Hook 触发，但没有确认该项目层确实被加载。实现时要用真实受信任的项目复测。

#### 2.2 未覆盖，实现前要补

- 全部 CLI：交互模式、`--resume`、Windows、WSL、SSH。
- Claude：两个 `--settings` 同时传入时的行为。
- Codex：真实受信任项目的隔离性；各 Codex 版本的 Hash 稳定性。
- OpenCode：工具事件；`plugin` 数组跨配置层的合并方式；经现有 `OPENCODE_CONFIG` 加载。
- Pi：配置 Provider 后的事件触发；与现有 `ccpanes-mcp.js` 共存。
- Grok：安装后实测 `--plugin-dir`；确认和用户配置共存。

#### 2.3 补充观察

- `codex features list` 显示 `plugin_hooks` 已移除，官方文档却仍列出插件 Hook，以实测版本为准。
- `opencode.rs` 已按会话设置 `OPENCODE_CONFIG`，是最自然的接入点，但本次实测用的是另外两个变量。
- **Grok 默认会扫描 Claude 和 Cursor 的 Hook 文件**（`GROK_CLAUDE_HOOKS_ENABLED` 默认开启）。cc-panes 写在项目 `.claude/settings.local.json` 的内置 Hook 可能也在 Grok 会话中运行，要核实是否重复触发。
- `grok.rs` 头注释说 Grok 没有按启动覆盖的入口。如果 `--plugin-dir` 确认可用，这条过时了，MCP 也可能不用再写用户级配置，留作后续提案。

---

## 3. Design

### 3.1 页面结构

```
资源中心                       [工作空间 ▾]  [显示的启动档 ▾]  [发现]
[ MCP · 8 ] [ Skills · 42 ] [ Hooks · 3 ]
────────────────────────────────────────────────────────────────
由启动档管理
  github      ● 正常 · 共享     npx -y @x/github    [全部][默认][评审][快速]
  postgres    ◐ 需要环境变量    …                   [全部][默认][评审][快速]
本层配置（对当前工作空间/项目始终生效）
  local-db    ● 正常 · 工作空间  …                   🔒 不受启动档控制
```

- **列是启动档，不是 CLI。** 开关显示启动档名称和其目标 CLI 的图标。
- **工作空间和项目是上层筛选**，决定“本层配置”显示哪一层。
- **启动档多时**：默认显示前 N 个，其余通过“显示的启动档”选择；选择结果按用户保存在本地。N 在实现时按窄窗口宽度确定。
- **发现入口**：页头固定按钮，跳到该 tab 的市场区。Skills 复用 `SkillMarketPage` 的数据层；MCP 市场不在本文范围内，一期不显示该按钮。

### 3.2 开关语义

开关只读写现有策略，**不新增并行状态**：

| 资源 | 读写字段 | 说明 |
|---|---|---|
| 内置 ccpanes MCP | `mcpPolicy.includeCcpanesMcp` | 现有逻辑见 `mcpHubModel.ts` |
| 共享 MCP | `mcpPolicy.enabledServerIds`、`disabledServerIds` | 判定复用 `isSharedMcpServerSelected` |
| 工作空间/项目 MCP | 无 | 现有模型不受启动档控制，显示锁定态并说明 |
| Skills | `skillPolicy.enabledSkillIds`、`disabledSkillIds`，分组开关对应 `include*` 字段 | 按现有 `launchProfileSkillPolicy.ts` 解释 |
| Hooks | 新增 `hookPolicy` | 见 3.6 |

策略 `mode` 为 `disabled` 时，该启动档的开关全部置灰，点击提示“该启动档已关闭 MCP/Skills”，并提供跳转。**不在点击开关时偷偷改 mode**：`default` 模式下切换单项时，沿用启动档编辑页已有的转换规则。

### 3.3 通用交互

从 magpie 借鉴，适配 React 实现：

- **不可用也可点：** 用 `aria-disabled` 而不是 `disabled`，点击后在行内显示原因。
- **乐观更新：** 点击立即生效，同一启动档的连续改动合并后写入，失败回滚到后端实际状态并提示。
- **局部更新：** 只更新受影响的行，不重绘列表，不丢滚动位置和焦点。
- **“全部”开关：** 只作用于可启用的启动档。
- **生效提示：** 每次改动后提示“下次启动生效”。
- **行状态标签：** 写在行内，关键信息不放进 tooltip。

### 3.4 一期：MCP

**粘贴添加。** 表单顶部增加粘贴区，识别 `mcpServers`、`servers` 和不带外层的单个条目。识别后展示确认列表：

- 名称、命令或 URL、目标层（共享、工作空间、项目）。
- 同名项默认不勾选，并标注“已存在”，由用户选择跳过或改名。
- env 和 headers 里的敏感值在确认列表中遮罩，不写日志。

**状态分级。** 替换现有单一的 Failed 展示，基于已有状态和错误信息归类，不新增探测：

| 显示 | 含义 | 颜色 |
|---|---|---|
| 运行中 | 正在运行 | 正常 |
| 启动中 | 正在启动 | 强调色 |
| 已停止 | 未运行，且没有错误 | 中性 |
| 失败 | 启动或健康检查失败，行内显示原因 | 错误 |
| 随会话启动 | 本层 server，由 CLI 随会话启动，cc-panes 不探测 | 中性 |

现有失败信息只有退出状态（如 `Exited: …`），没有“缺环境变量”这类信号，所以“未检查”这一级暂不做，避免靠猜文案。要做需要后端先给出结构化原因。

**粘贴的限制：** 现有 `mcpService.upsertServer` 只传 command、args、env，`SharedMcpServerConfig` 也没有 url，所以远程条目能识别但不能添加，确认列表会说明。要支持需要扩展 Tauri 命令和 REST 路由，留作后续。

### 3.5 二期：Skills

- 行状态标签：有更新、本地已改动、上游已删除。
- 更新前检测本地改动：有改动时询问，默认不覆盖；被替换的版本保留备份。
- 上游删除只打标签，不自动删除。
- 按来源（内置、工作空间、项目、市场/仓库）分组，分组标题支持整组操作。
- 安装入口沿用市场；是否支持“粘贴任意地址探测”在二期再评估。

### 3.6 三期：Hooks

**数据模型（新增）：**

```ts
interface ResourceHook {
  id: string;
  name: string;
  description?: string;
  event: "session-start" | "prompt" | "before-tool" | "after-tool" | "turn-end";
  matcher?: "shell" | "edit" | null; // 仅工具事件
  command: string;
  timeoutSecs?: number;
}

interface LaunchProfileHookPolicy {
  enabledHookIds: string[];
}
```

- Hook 定义保存在 CC-Panes 自己的数据目录，不进项目仓库。具体文件在实现时按 `cc-panes-paths` 约定确定。
- `LaunchProfile` 增加 `hookPolicy`，Rust 侧 `#[serde(default)]`，旧配置加载后为空列表，即全部关闭。

**事件映射：**

| 通用事件 | Claude、Codex、Grok | OpenCode 插件 | Pi 扩展 |
|---|---|---|---|
| `session-start` | `SessionStart` | 待定（session 事件） | `session_start` |
| `prompt` | `UserPromptSubmit` | 待定 | `before_agent_start` |
| `before-tool` | `PreToolUse` | `tool.execute.before` | `tool_call` |
| `after-tool` | `PostToolUse` | `tool.execute.after` | `tool_result` |
| `turn-end` | `Stop` | `session.idle` | `agent_end` |

`matcher` 按 CLI 映射。Claude：`shell` → `Bash`，`edit` → `Edit\|Write\|MultiEdit`。Codex：`shell` → `Bash`，`edit` → `apply_patch`。其余 CLI 的工具名在补验证时确定。OpenCode 和 Pi 的语义（能否阻断、输入输出格式）与命令式 Hook 不完全相同，包装层要统一或明确标注差异。

**注入链路：**

1. `CliToolCapabilities` 增加 `supports_session_hooks`，五个 CLI 在各自补验证通过后设为 `true`。
2. 启动时解析启动档的 `hookPolicy`，放入适配器上下文。
3. 各适配器按自己的入口注入：

| CLI | 注入方式 |
|---|---|
| Claude | `claude.rs` 的 `build_command` **已用 `--settings` 传 Provider 配置**（`generate_provider_settings`）。Hook 合并进同一个按会话生成的文件，只传一个 `--settings` |
| Codex | `codex.rs` 已有 `-c mcp_servers.*` 的展开逻辑，同样增加 `-c hooks.*` 和整表 `-c hooks.state=…`，见 2.1 |
| OpenCode | 生成 JS 插件，把路径加入现有按会话配置（`OPENCODE_CONFIG`）的 `plugin` |
| Pi | 生成扩展文件，通过 `-e` 传入。不写 `extensions/` 目录 |
| Grok | 生成插件目录（`hooks/hooks.json`），通过 `--plugin-dir` 传入 |

4. 生成的文件沿用现有 MCP 配置文件的生命周期规则（`mcp_config_lifecycle.rs` 的会话退出后保留期），保证 resume 和后台任务不会丢配置。
5. `wsl_codex.rs` 有独立的参数拼装，首版不注入，并在界面说明。

**内置与自定义分开：**

- 内置 Hook 显示在单独分组，继续走 `projectCliHooksService` 的项目级开关，不进启动档列。
- 现有文案已提示关闭可能导致记忆召回失效，保留该提示。

**安全：**

- Hook 以用户权限执行任意命令。添加和修改时都显示完整命令并要求确认。
- 首版不支持导入和分享，避免一键引入他人命令。
- 日志只记录 Hook 名称和退出状态，不记录命令输出。
- YOLO 模式不改变上述确认要求。

**不支持时的表现：** 启动档的目标 CLI 都不支持时，开关置灰并说明原因。目标 CLI 部分支持时可以启用，并标注实际生效的 CLI。

### 3.7 迁移

- **没有数据迁移**，MCP 和 Skills 继续用现有存储。
- 旧入口在对应一期完成后改为跳转资源中心；启动档编辑页的卡片保留，因为它回答的是另一个问题：“这个启动档用了什么”。
- Web 和移动端通过现有 `invokeOrApi` 模式保持一致，三期新增的命令要同时补 REST 路由。

### 3.8 与进行中工作的关系

UI 重设计会话（worktree `cc-pane-wt-ui-native-feel`）正在修改 `MainViewSwitcher.tsx` 等全局外壳。资源中心的导航接入要等它合并后再做，或提前约定改动边界。

### 3.9 Affected Files

**一期**
- `web/components/resources/ResourceCenter*.tsx`、`ProfileChips.tsx` [ADDED]
- `web/components/resources/mcp/*`、`pasteMcpConfig.ts` [ADDED]
- `web/components/layout/MainViewSwitcher.tsx` [MODIFIED]
- `web/components/settings/SettingsPaneContent.tsx`、`mcpHubModel.ts` [MODIFIED]
- `web/i18n/locales/{zh-CN,en}/*.json` [MODIFIED]

**二期**
- `web/components/resources/skills/*` [ADDED]
- `src-tauri/src/services/skill_remote_update_service.rs` [MODIFIED]
- `web/components/skill/WorkspaceSkillsHub.tsx`、`LinkSkillManager.tsx`、`web/components/resources/GlobalSkillsPanel.tsx` [MODIFIED]

**三期**
- `cc-panes-core/src/services/hook_library_service.rs`、`src-tauri/src/commands/hook_library_commands.rs`、`cc-panes-web/src/routes/hook_library.rs`、`web/services/hookLibraryService.ts`、`web/types/resource-hook.ts`、`web/components/resources/hooks/*` [ADDED]
- `cc-panes-core/src/models/launch_profile.rs`、`cc-panes-core/src/services/launch_profile_service.rs`、`web/types/launch-profile.ts` [MODIFIED]
- `cc-cli-adapters/src/lib.rs`、`claude.rs`、`codex.rs`、`opencode.rs`、`pi.rs`、`grok.rs` [MODIFIED]

---

## 4. Tasks

### 一期：框架 + MCP
- [x] 确认“资源中心”模块现状：`moduleNames.resources` 只有文案，没有代码使用，可直接用这个名字
- [ ] 与 UI 重设计会话约定外壳改动边界
- [x] 实现 `ProfileChips`：不可用可点、“全部”，含测试
- [x] 启动档写入是整份覆盖，增加按启动档的串行写队列和乐观显示（`useProfilePolicyWriter`）
- [x] 抽出开关和策略的读写函数（`resourceCenterModel`），判定和切换复用启动档编辑页的函数
- [x] 实现 MCP tab 列表、分层和锁定态
- [x] 实现粘贴解析（`pasteMcpConfig`）及确认列表，含重名和敏感值遮罩测试
- [x] 实现 MCP 状态展示（调整见 3.4）
- [x] 临时入口：设置 → AI 工具 → 资源中心
- [ ] 接入正式导航，旧入口改为跳转（等 UI 重设计合并）
- [ ] 本层 server 的编辑和删除迁入资源中心（目前仍在原 MCP 页）
- [x] 补充中英文文案，通过前端基线检查
- [ ] 在真实 Tauri 应用中验证（目前只在 mock 数据下渲染过）

### 二期：Skills
- [ ] 核实现有更新服务能否取得本地改动信息，确定检测方案
- [ ] 实现更新前检测、询问和备份
- [ ] 实现 Skills tab：分组、状态标签、启动档开关
- [ ] 上游删除只打标签，并提供显式清理
- [ ] 旧入口改为跳转，保留启动档卡片

### 三期：Hooks
- [ ] 完成 2.2 列出的补验证，按结果确定各 CLI 能否进入首批
- [ ] 核实 Grok 扫描 Claude Hook 是否导致内置 Hook 重复触发
- [ ] 增加 `ResourceHook`、`hookPolicy` 模型，覆盖旧配置加载测试
- [ ] 实现 Hook 存储服务、Tauri 命令、REST 路由和前端 service
- [ ] 增加 `supports_session_hooks` 能力，并覆盖各适配器测试
- [ ] `claude.rs` 合并 Provider 配置和 Hook 到单个按会话生成的文件，含事件映射测试
- [ ] `codex.rs` 注入 `-c hooks.*` 和单条信任：取得并缓存 Hash，Hash 不匹配时在界面提示，含测试
- [ ] `opencode.rs` 生成 JS 插件包装层并接入现有按会话配置，含测试
- [ ] `pi.rs` 生成扩展包装层并通过 `-e` 传入，含测试
- [ ] `grok.rs` 生成插件目录并通过 `--plugin-dir` 传入，含测试
- [ ] 复用配置文件生命周期规则，覆盖 resume 和退出场景
- [ ] 实现 Hooks tab：编辑器、完整命令确认、内置分组、不支持时的原因
- [ ] 端到端验证：启用后 CLI 主目录无变化，其他启动档不触发

### 三期之后的调研（不阻塞）
- [ ] Kimi、Gemini：实测第 2 节的候选入口
- [ ] Cursor：等上游提供按会话入口
- [ ] Grok：`--plugin-dir` 可用后，评估 MCP 是否改为按会话注入

---

## 5. 待决问题

1. **“资源中心”模块的现状。** i18n 里有 `moduleNames.resources`，但本次没有确认它现在渲染什么。这决定是复用还是替换。
2. **本层 MCP 是否也要受启动档控制。** 本文保持现状（始终生效、锁定显示）。改变它是产品决策，不在本文范围内。
3. **是否接受 Codex 依赖非公开的信任格式。** 本文按“接受，并在 Hash 不匹配时提示”设计，代价是 Codex 升级后可能要跟着调整。

## 6. Log

### 2026-11-02
- 完成 magpie 调研和 Hook 注入验证，提交本提案供评审。尚无代码改动。
- 调研主流 CLI。更正：Codex 最初“未触发”的原因是 Hook 信任机制。
- 一期首轮实现（未提交）：MCP tab、启动档开关、粘贴添加，临时入口放在设置页。
- 确定 Hooks 首批支持 Claude、Codex、Grok、OpenCode、Pi。实测 Codex 可按会话预置单条信任，无需跳过全部信任检查；查明 Grok `--plugin-dir` 和 Pi `-e` 两个入口。
