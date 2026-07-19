# Provider 面板重构：从"劣化启动器"回归纯凭证管理

> 状态：待实施 | 基线提交：`6a29b61` | 关联：`docs/22-frontend-design-refactor.md`、`docs/provider-design-decision.md`

## 背景

资源中心 → Provider 凭证面板同时承担了「凭证管理」和「启动会话」两种职责，
而后者在 `web/components/launcher/`（全局启动器）落地后已经完全重复，且实现质量更差。

用户反馈三条，根因不同：

| 反馈 | 根因 |
|------|------|
| "UI 太难看" | 硬编码色 + 身份色/状态色混用 + 图标常驻 + 卡片过重 |
| "默认是系统环境变量，为什么没启动" | 绿色按钮文案是「启用」但行为是「启动会话」；「设为默认」是不起眼的星图标 |
| "竟然要去 provider 里面去加入" | ProvidersPanel 重复实现了启动入口，把用户从正路（`Ctrl+T` 全局启动器）引偏 |

## 核心判断

**全局启动器 `LauncherDialog` 已经是正确的启动路径**，且 `Ctrl+T` 已直接唤起它
（`web/hooks/useShortcutRegistrations.ts:91-98`）。它有完整的
CLI（`LauncherCliRow`）/ 运行环境（`LauncherEnvRow`）/ 凭证（`LauncherProviderRow`，
providerSelection 三态 + 凭证下拉）选择。

因此本次**不做信息架构重构，只做删除与收敛**：ProvidersPanel 退化为纯管理面板。

## 三个动词的错配（当前状态）

`web/components/providers/ProviderCard.tsx` 单卡承载三种语义：

| 视觉 | i18n key | 实际行为 | 权重 |
|------|----------|----------|------|
| 绿色大按钮「启用」 | `settings:launch` | 启动终端会话（一次性） | 最高 ❌ |
| 星形小图标 | `settings:setAsDefaultBtn` | 设为默认凭证（持久状态） | 最低 ❌ |
| 铅笔 / 复制 / 垃圾桶 | — | CRUD | 中 |

权重与重要性完全相反。

## 实施范围

### A. ProvidersPanel 退化为纯管理面板

1. 删除 `ProviderCard` 的启动按钮（`ProviderCard.tsx:88-96` 系统分支、`:186-194` 普通分支）
   及 `onLaunch` prop。
2. 删除 `ProvidersPanel.handleLaunch`（`ProvidersPanel.tsx:164-204`）——连同其中
   `resolveWorkspaceLaunchOptions` 调用与 7 种 issue 错误分支，它们只服务于这个入口。
   随之可清理的 import：`useDialogStore`、`useWorkspacesStore`、`resolveWorkspaceLaunchOptions`
   等（以实际引用为准，勿误删仍被使用的）。
3. 「设为默认」从角落星图标提升为卡片主操作（非默认卡显示为文字按钮；已默认卡显示为
   不可点的「默认」状态标识）。
4. 面板内增加一行引导，说明"用某个凭证启动会话请按 `Ctrl+T` 打开启动器"，
   避免删除按钮后用户认为功能丢失。文案走 i18n，勿硬编码。

### B. 「系统环境变量」可设为默认 + 探测结果可见

现状问题（三条独立成因，需一并解决）：

- 系统条目 `__system__` 是前端合成的伪条目（`web/types/provider.ts:34-51`），不落盘；
  其卡片分支（`ProviderCard.tsx:52-100`）**不渲染** `onSetDefault`，无"设为默认"入口。
- 后端 `set_default_provider`（`cc-panes-core/src/services/provider_service.rs:205-212`）
  会将所有 provider 的 `is_default` 置 false，而 `__system__` 不在 `config.providers` 内，
  对它调用等于"清空所有默认"，无持久化状态。
- 「默认」徽章是 render 现算的派生值（`ProvidersPanel.tsx:113-117`），条件为
  `systemActive && activeTab === "claude" && runtime ∈ {local, null} && !providers.some(isDefault)`
  ——只要存在任一默认 provider 即被打掉，但系统卡仍置顶，造成"它是默认"的误读。

改动：

1. 后端 `ProviderConfig` 增加持久化标记（建议 `default_is_system: bool`），
   `set_default_provider` 接受 `__system__`：置 `default_is_system = true` 并清空所有
   provider 的 `is_default`；设置任一真实 provider 为默认时置 `default_is_system = false`。
   保持 `SYSTEM_PROVIDER_ID` 仍不落入 `config.providers`（`provider_service.rs:101-103/127-128/155-156`
   的禁止落盘约束不变）。
2. 前端 `useProvidersStore` 暴露该标记，替换 `ProvidersPanel.tsx:113-117` 的派生判定。
3. 系统卡显示**探测到的实际变量**：有哪些（键名，不显示值）/ 一个都没有。
   数据来自 `detect_system_provider`，需扩展返回值以携带命中的变量名列表。
4. 运行环境警示：`systemActive` 探测是宿主进程级的
   （`provider_service.rs:82-95`：`~/.cc-switch/cc-switch.db` 或宿主
   `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`），在 WSL/SSH 下
   不代表目标环境。当前运行环境非 local 时，卡片需明确提示该探测不适用。
5. 修 `web/stores/useProvidersStore.ts:38-40` 的空 catch——探测失败当前完全静默，
   改为至少记录（`handleErrorSilent` 或等价方式）。

> 语义不变：选择系统条目仍走 `providerSelection: "none"`，后端
> `get_env_vars` 短路返回空 map（`provider_service.rs:218-223`），即"不注入"而非"清空"。
> 参见 `docs/provider-design-decision.md:377,416`。

### C. 视觉收敛（对齐 `docs/22-frontend-design-refactor.md`）

`ProviderCard.tsx` 现存违规：

| 位置 | 问题 | 目标 |
|------|------|------|
| `:91`、`:189` | `background: "#16a34a"` 硬编码绿，且用状态色表达动作 | 随启动按钮一并删除 |
| `:53` | `systemAccent = "#0EA5E9"` 硬编码 | 用 token（`--app-accent` 或 identity token） |
| `:16-21` | `TYPE_COLORS` 硬编码色表 | 归入 identity 语义；如需保留则登记进 `designTokens.test.ts` ALLOWLIST 并注明理由 |
| `:59`、`:118` | `borderLeft: 4px solid {accentColor}`，用**身份色**表达**默认状态** | 3px + `--app-accent` + `rounded-r-md`（文档 §1 激活态约定） |
| `:177/:202/:210/:219/:228` | 原生 `title=` | 改用 `ui/IconTooltipButton`（文档 §5） |
| `:121` | 卡片 `p-4` + 头像 `w-12 h-12` | 对齐项目惯例 `p-3` + `w-10 h-10`（参考 `HomeRecentProjects.tsx:134-146`） |
| `:197-232` | CRUD 图标常驻 | `opacity-0 group-hover:opacity-100`（参考 `HomeRecentProjects.tsx:167`） |
| — | 无空状态 | 用 `ui/EmptyState` |

卡片 hover 补 `--sh-sm → --sh-md`（文档 §5）。

> 注意：`designTokens.test.ts` 扫的是 className，`style={{}}` 内的硬编码色未被覆盖。
> 本次不要求扩展该测试，但新代码不得再往 `style` 里塞硬编码色。

### D. 独立 bug（与上述解耦，可先行）

1. **i18n 对象报错**：`web/components/resources/ResourceHub.tsx:22` 的
   `t("sharedMcp")` 命中的是对象节点（`web/i18n/locales/*/settings.json:317`），
   触发 `key 'sharedMcp (zh-CN)' returned an object instead of string` 并显示在界面上。
   改为 `t("sharedMcp.title")`。
2. **缺失 i18n key**：同文件 `:20-21` 的 `skills`、`:33` 的 `resourceHub` 在
   zh-CN/en `settings.json` 中不存在，靠 `defaultValue` 兜底——补齐。
3. **硬编码中文**：`ProvidersPanel.tsx:345-346`、`:369-370` 的
   「运行配置 / Provider 凭证」分段控件未接 i18n。
4. **失效的预设匹配**：`ProviderCard.tsx:10-13` 的 `getAccentColor` 用
   `provider.name.includes(p.nameKey.replace("preset","").replace("Name",""))`
   ——拿 i18n key 做字符串裁剪去匹配用户自定义名称，几乎必然失配，
   多数 provider 静默落到 `TYPE_COLORS` 兜底。改为按 `providerType`（或显式
   `presetId` 字段）匹配。
5. **措辞**：`zh-CN/settings.json:301` `"launch": "启用"` 语义误导。
   若删除启动按钮后该 key 在本面板不再使用，确认其它引用点后再决定改文案或保留。

## 不做什么

- 不改 `LauncherDialog` 及其九段式配置。
- 不改 `providerSelection` 三态语义与后端 `get_env_vars` 解析链
  （`terminal_service.rs:1343-1352`）。
- 不拆 `LaunchProfilesPanel.tsx`（2094 行，另案）。
- 不碰红线：TerminalView 渲染生命周期、`terminal_service` 的 CR 提交、
  OSC/hook 会话状态链路。

## 验收

- `npx tsc --noEmit` 通过
- `npm run test:run -- --maxWorkers=3` 全绿（基线 276 文件 / 2587 测试）
- `cargo check --workspace` + `cargo clippy --workspace -- -D warnings` 通过（涉及后端改动时）
- 手动：资源中心 Provider 页无 i18n 报错横幅；系统条目可设为默认且状态持久；
  设为默认后重启应用仍生效；卡片无绿色按钮；CRUD 图标 hover 才现
