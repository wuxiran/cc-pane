# 72. WorkBuddy 商业化：内置中转站预设 + 业务用户版

> 创建日期：2026-08-02。来源：erpworkspace 侧的产品评估会话，对 AionUi 私有 fork / Orca / cc-panes 三方做过对照。
> 本文是**交给 cc-panes 侧执行的需求文档**，不是已实现记录。MCP 业务工具层（`yunzhu-mcp`）由 erpworkspace 侧并行开发，不在本文范围。
> 相关：[23-ccpanel-competitor-evolution.md](./23-ccpanel-competitor-evolution.md)、[43-orca-competitor-analysis.md](./43-orca-competitor-analysis.md)、[55-competitor-gap-rescan.md](./55-competitor-gap-rescan.md)

---

## 0. ⚠️ 这是一次方向调转，不是既有路线的延续

现有文档体系里有三处**明确拒绝商业化**的记录，本文与之相反，需要显式推翻：

| 位置 | 原立场 |
|---|---|
| `23-ccpanel-competitor-evolution.md:386` | 「**PRO 付费墙拆分——阶段不符**」（列在"明确不做/不抄"） |
| `55-competitor-gap-rescan.md:100` G3 | 「**不为竞品变现路径引入云身份和团队 ACL；本地优先、无强制账号是定位优势**」（🗑️ 不值得） |
| `43-orca-competitor-analysis.md:257` | 把「本地优先无账号」列为护城河，并称「YC 迟早要账号体系变现」 |

**新立场（2026-08-02 决策）**：cc-panes 走 **open-core**——软件本体保持开源免费，商业化落在**中转站额度**与**垂直业务工具**上，不引入强制账号、不做功能付费墙。

这与旧立场的**兼容点**：仍然本地优先、仍然无强制账号、开源版功能不阉割。变的只是"官方提供一个可选的付费供给渠道"。

与 Orca 的差异：Orca 是纯 BYO（用户自带 CLI 订阅），cc-panes 多一步——**顺便把订阅也供了**。这是差异化，也是唯一的收入来源。

---

## 一、任务 A：内置中转站 Provider 预设（P0，目标 2 天）

### 目标
让用户在 cc-panes 里**零配置接入云筑中转站**：设置 → Provider → 选「云筑中转站」→ 填 key → 完成。不再需要用户自己查 base_url。

### 现状（已核实，可直接复用）
- `cc-panes-core/src/models/provider.rs:35-53` `Provider` 已有 `base_url` / `api_key` 字段
- `provider.rs:57-68` `to_env_vars()` 对 `Anthropic` / `Proxy` 类型注入 `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`
- `provider.rs:100-107` `OpenAI` 类型注入 `CODEX_API_KEY` + `OPENAI_BASE_URL`
- UI：`web/components/providers/ProviderFormPanel.tsx` / `ProvidersPanel.tsx` / `ProviderToolTabs.tsx`

**结论：底层能力已具备，本任务只是加一层"预设"，不改 env 注入逻辑。**

### 需求
1. **预设数据源**：新增一份内置 provider 模板列表（建议放 `cc-panes-core/src/models/provider_presets.rs` 或前端常量，由实现方定）。首批只需一条：

   | 字段 | 值 |
   |---|---|
   | name | 云筑中转站（暂定，最终名称待定） |
   | base_url | `https://hub.nocannobb.com`（**需实现时确认路径后缀，Anthropic 兼容端点通常不带 `/v1`，OpenAI 兼容端点带 `/v1`**） |
   | provider_type | `Anthropic`（给 Claude Code 用）+ `OpenAI`（给 Codex 用）各一条 |
   | api_key | 空，用户填 |

2. **UI**：Provider 新建表单加「从预设创建」入口，选中后自动填好 `name` + `base_url`，只留 `api_key` 待填。

3. **可扩展**：做成**列表**而不是写死单条——后续可加其他公开中转站。自家的排第一并标「官方推荐」。这样对开源社区观感干净，也不得罪其他渠道。

4. **注册引导**：预设项旁边给一个"获取 key"链接，指向注册页。

### 验收
- 全新安装 → 设置 → Provider → 从预设选云筑 → 填 key → 保存 → 启动 Claude Code 会话能正常出字
- Codex 同样路径可用（走 `OpenAI` 类型 + `OPENAI_BASE_URL`）
- 预设不影响现有自定义 provider 的增删改
- `to_env_vars()` 无改动（回归风险为零）

### 提交策略
**进开源主线**，作为官方推荐渠道。

---

## 二、任务 B：业务用户版（WorkBuddy 模式，P1）

### 背景
面向**非技术业务用户**（贸易/食品/化工企业的开单员、安全员），卖点是"用自然语言操作 ERP/HSEIP"。他们看到终端、worktree、git、pane 布局会直接关掉。

商业模型是**按业务动作计费**（如"微信截图→销售订单 ¥0.5/单"，实际 token 成本约 ¥0.01），不是按 token 卖——客户看得懂"一单五毛"，看不懂"一百万 token"。

### B1. 入口：新增 `mode=workbuddy` 路由（最低成本切入点）

`web/App.tsx:29-55` 是纯 query-param 分发，`web/main.tsx:59-62` 还有 `mode === "ccchan"` 走独立 React 根。**照抄这个模式**：

```tsx
if (params.get("mode") === "workbuddy") return <WorkBuddyApp />;
```

独立 React 树，完全绕开 `MainApp` / `MainViewSwitcher` / `AppShell`，**零回归风险**。

> ⚠️ 不要走"裁剪 MainApp"路线。`MainViewSwitcher.tsx:126-177` 的终端区耦合了 `DndPaneProvider` / `LayoutTopBar` / `LayoutVisibilityContext` / 壁纸 token，且 `55-competitor-gap-rescan.md:114` H7 把 TerminalView 的「零丢字节/无重复/重连恢复顺序」列为**红线**。

### B2. 聊天引擎：cc酱现状不足以支撑（**主体工作量**）

`src-tauri/src/services/ccchan_service.rs`（2096 行）当前是**桌宠玩具**，不是聊天客户端地基。逐条缺口：

| # | 缺口 | 证据 | WorkBuddy 是否必须 |
|---|---|---|---|
| 1 | **MCP 被关闭** | `skip_mcp: true`（`:851`、`:902`） | **必须开**，业务工具全靠它 |
| 2 | **权限拿不到** | `yolo_mode: false` + `claude -p` 非交互，需授权的工具直接失败，无确认 UI | **必须**，写 ERP 要确认 |
| 3 | 无历史持久化 | 消息在 React state（`web/ccchan/CCChanApp.tsx:132`），80 条/16000 字上限（`ChatPanel.tsx:45-46`）；resume id 只在内存 `Mutex`，重启即丢 | **必须**，业务用户要查昨天的单 |
| 4 | 只能一个会话 | `chat_session: Mutex<Option<ChatSessionState>>`（`:172`），新建强制替换旧的 | **必须**，多话题 |
| 5 | 每轮冷启动 CLI 进程 | `run_structured_claude_turn`（`:615-820`）每次 `command.spawn()` | 应优化，Windows 上 node 启动几百 ms~秒级 |
| 6 | 无附件/图片 | `send_to_chat(text: &str)`（`:411-416`） | **必须**，核心场景就是发截图 |
| 7 | 停止按钮不杀进程 | `stop_chat` 对 structured 分支只 emit `exited`（`:497-514`） | 必须 |
| 8 | 无 i18n | ChatPanel 全中文硬编码（`:348-353`、`:384`、`:429` 等） | 后续 |
| 9 | 无主题 | 颜色硬编码十六进制（`:263-267`、`:289-293` 等），不走 `--app-*` token | 后续 |
| 10 | 窗口是 120×120 桌宠，聊天态最大 460×680 | `:1264-1292` | 需主界面级窗口 |
| 11 | 流式颗粒度粗 | `parse_claude_stream_line`（`:1595+`）解析整块消息非 token 增量；前端靠字符串包含去重（`ChatPanel.tsx:229-251`） | 体验项 |

**另有两处技术债需顺带清理**：
- `ChatSessionState::Terminal` 分支是**死代码**：`start_chat`（`:329-409`）经 `parse_ai_engine`（`:1546-1555`）只接受 `claude`/`codex`，`:354-359` 又把两者全路由到 structured，`:361-408` 的 PTY 路径永远走不到
- `ChatPanel.tsx:47-207` 约 200 行 ANSI/TUI 噪声清洗（含 `TERMINAL_CHROME_COMPACT_MARKERS` 硬编码黑名单）是为上述死路径服务的历史包袱
- 系统提示词 `src-tauri/resources/claude-bundle/default-skills/ccchan-helper.md` 写着 "Use ccpanes MCP tools…"，但代码 `skip_mcp: true`——**提示词与实际能力矛盾**

### B3. 助手体系：复用 `LaunchProfile`

`cc-panes-core/src/models/launch_profile.rs:6-31` 已有 `provider_id` / `target_tools` / `mcp_policy`（`:80-91` 可白黑名单 MCP server）/ `skill_policy`（`:116+`）/ `yolo_mode`。

**只缺 `system_prompt: Option<String>` 字段**。下游管道已贯通：`append_system_prompt` 存在于 `cc-panes-core/src/models/terminal.rs:85`，WSL/Codex 路径见 `cc-panes-core/src/services/terminal_service/wsl_codex.rs:1411`（当前唯一使用者是 ccchan 硬编码 `:849`/`:900`）。

加上这个字段后，「锦鸿昇开单助手」= 一条 LaunchProfile（绑定 `erp.*` MCP 工具子集 + 提示词 + provider）。

> 对照：`23-ccpanel-competitor-evolution.md:323` G3「专家库」当时判 ⚠️「无」——本任务正好补上，且对开源版同样有价值（用户可自建专家）。

### B4. 界面裁剪

- `web/modules/registry.ts:44-53` `ModuleDef` 已有 `minimal: boolean` 字段，但 `MODULE_REGISTRY`（`:128-185`）**六个模块全是 `minimal: false`**，导致 `useModulePrefsStore.ts:43-51` 的 `createModulePreferencesForPreset("minimal")` 会把模块全关掉
- 注册表只覆盖 6 个模块（`ssh`/`orchestration`/`resources`/`todo`/`aiPanel`/`sessionHistory`）；**终端、worktree、git、端口、pane 布局不在注册表内**，在 `MainViewSwitcher` 和 `Sidebar` 里硬接线
- `web/components/Sidebar.tsx` 按 `activeView`（`useActivityBarStore.ts:4`：`explorer|sessions|files|ssh|process|orchestration`）切换，6 个视图不走注册表

**若走 B1 的独立路由，以上都不需要裁**——这也是推荐 B1 的主因。

### B5. 设置页收窄
`web/components/settings/settingsRegistry.ts:88`/`:231-241` 是单个数组（16 个 pane），WorkBuddy 模式下只保留 provider / notification / general / about 即可。

---

## 三、任务 C：授权体系（P2，仅业务版需要）

### 现状：**完全没有**
全仓搜 `license_key` / `activation` / `subscription` / `expiry` / `device_binding` **零业务命中**（全部命中是 dnd-kit 的 `activationConstraint` 和 TerminalView 的 pane activation，语义无关）。

唯一的访问控制是 Web 远程访问密码（`src-tauri/src/commands/web_access_commands.rs:108` + `web/components/WebAuthGate.tsx`），是会话级 Cookie，不是授权体系。

### 需求（参考实现：AionUi 私有 fork 的 P1–P4 已跑通这套）
- 激活码登录门（错误码：`invalidKey` / `revoked` / `expired` / `deviceLimit`）
- 设备指纹绑定 + 设备数上限
- 订阅到期时间 + **离线宽限期**
- 凭据下发：服务端返回 base_url + key，客户端自动 seed provider，用户不可改

**关键设计（白送的架构优势）**：凭据由服务端下发意味着——中转站出问题时，**改服务端返回值即可全客户切换兜底通道，客户端不用重新发版**。

⚠️ 授权体系只进**业务版构建**，不进开源主线（与第 0 节的 open-core 立场一致：开源版无强制账号）。

---

## 四、优先级与依赖

```
任务 A（内置预设，2天）── 独立，可立即开工
                          │
任务 B2（聊天引擎重写）───┼── B1 路由（低成本，先做）
                          ├── B3 LaunchProfile 加 system_prompt
                          └── 依赖 erpworkspace 侧的 yunzhu-mcp 工具就绪
任务 C（授权）─────────── 仅业务版，最后做
```

**建议顺序**：A → B1 → B3 → B2 → C

任务 A 与其余全部解耦，且是唯一能立刻产生收入的部分（开发者用户充值），**优先做完上线**。

---

## 五、分工

| 侧 | 负责 |
|---|---|
| **cc-panes** | 本文全部任务（A / B / C） |
| **erpworkspace** | `yunzhu-mcp`（Rust + rmcp）：`erp.*` / `hseip.*` / `mall.*` 工具集；ERP 侧凭据签发与动作计量 |
| **sub2api** | 客户分组、`billing_rate_multiplier`、充值/超额、易支付（现有能力，零改造） |

**接口约定**：`yunzhu-mcp` 是标准 stdio MCP server，cc-panes 按现有 `mcp_config_service.rs` 方式挂载即可，双方无特殊耦合。
