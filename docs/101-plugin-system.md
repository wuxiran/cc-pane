# 101 · 插件系统：资源库「插件」页 + 短剧制作台插件化

> 状态：设计稿（2026-11-20，基于 dev/v0.12.23），**未实施**。本文只定范围、格式和落点；分批实施时以此对照。
> 相关：docs/97（技能市场 / 工作空间技能 = Claude 插件目录）、docs/98（目录职责）、docs/109（资源库）、docs/100（短剧流水线）。
> 参照：同作者的 BlackCatCrazy 插件体系（`blackcatcrazy/src/feat_plugins.rs`、`feat_market.rs`、`blackcatcrazy-plugins/index.json`）。

## 0. 结论先行

1. **CC-Panes 插件 = 一个带清单（`plugin.json`）的功能包**，可以贡献四类东西：主视图（活动栏入口 + 全屏页）、技能、MCP 服务器、设置项。第一期**只做内置插件**：代码随 App 发布，插件只负责「开 / 关 + 入口注册」。
2. **短剧制作台是第一个内置插件**（`drama-studio`）。实验开关 `experimental.dramaStudio` 下线，改由 `plugins.enabled["drama-studio"]` 控制；已经打开过的老用户经 `settingsVersion` 迁移保持开启。
3. **清单与目录格式沿用 BlackCatCrazy**（`index.json format:1` + `plugin.json` 字段名），只把 `engines` 的键换成 `cc-panes`、`contributes` 扩充 CC-Panes 自己的贡献点。插件目录同时是一个合法的 Claude Code 插件目录，技能 / MCP 直接走现有的 `--plugin-dir` 注入。
4. **不做**：第三方原生代码（Rust 动态库、任意可执行文件）；第三方网页界面直接跑在主 WebView 里（理由见 §3）。

## 1. 插件是什么：范围与分期

| 贡献点 | 内容 | 第一期 | 第二期 | 第三期 |
|---|---|---|---|---|
| `views` 主视图 | 活动栏图标 + 一个 `appViewMode` 全屏页 | ✅ 仅内置 | — | 沙盒网页视图（独立 WebView） |
| `skills` | 插件目录下 `skills/<name>/SKILL.md` | — | ✅ 走 `--plugin-dir` / Codex `skills.config` | — |
| `mcpServers` | 声明式 MCP 定义（stdio/remote） | — | ✅ 装插件时写成共享 MCP 条目，按启动档开 | — |
| `settings` | JSON Schema → 自动生成表单（照搬 BlackCatCrazy 的 `secret`） | — | ✅ | — |
| `service` 后台程序 | 本机常驻服务（BlackCatCrazy 的 `service`） | ❌ | ❌ | 视需求再立项 |

**明确不做**：
- 不加载第三方 Rust / 原生代码，也不往 `invoke_handler` 里动态注册命令。内置插件的后端命令（如 `drama_commands.rs`）照常编译进 App。
- 不让第三方网页拿到 `window.__TAURI_INTERNALS__`：Tauri 2 的 capability 管不住 App 自定义命令（`kill_session`、文件读写这一类），主 WebView 里任何能 `invoke` 的代码都等于拿到全权。
- 插件不改 `~/.claude` 等 CLI 主目录，也不改项目文件（延续 docs/97、docs/98 的「按会话注入、零写入」）。
- 停用插件不删数据：`drama_*` 表照常由 `db.rs` 的迁移建出，停用只隐藏入口。

**为什么第一期只做内置插件**：真正要插件化的功能（短剧台、资料空间）都是第一方代码，而且依赖 React 组件、Zustand store、Tauri 命令，抽成沙盒网页的成本远大于收益。先把「插件」这个用户心智、开关、资源库入口和目录格式定下来，第二期再让外部插件贡献技能 / MCP（这些都是纯数据，安全面小）。

## 2. 清单格式、磁盘位置、目录源

### 2.1 `plugin.json`（BlackCatCrazy 字段 + CC-Panes 扩展）

```jsonc
{
  "id": "drama-studio",              // 小写字母数字和 -，与目录同名（照搬 valid_id）
  "name": "短剧制作台",
  "version": "1.0.0",
  "description": "剧本 → 分镜 → 镜头 → 成片流水线",
  "author": "CC-Panes", "license": "MIT", "homepage": "", "icon": "icon.svg",
  "engines": { "cc-panes": ">=0.12.23" },   // 复用 ver_in_range 语义
  "platforms": [],                           // 空 = 全平台
  "builtin": true,                           // 新增：内置插件，不可卸载，没有 download
  "permissions": [],                         // 第二期：skills / mcp / network 等，装时逐条展示
  "contributes": {
    "views":      [{ "id": "main", "mode": "dramaGen", "icon": "clapperboard", "title": "短剧制作台" }],
    "skills":     true,                      // 第二期：本目录作为 Claude 插件目录挂载
    "mcpServers": [],                        // 第二期：SharedMcpServerConfig 形状
    "settings":   null                       // 第二期：JSON Schema
  }
}
```

插件目录布局（第二期起对外部插件生效）。根目录的 `plugin.json` 给 CC-Panes 读，`.claude-plugin/` 给 Claude Code 读，两者并存，互不冲突：

```text
<plugin>/
  plugin.json                 ← CC-Panes 清单
  .claude-plugin/plugin.json  ← 缺失时安装器自动生成（同 docs/97 工作空间技能）
  skills/<name>/SKILL.md
  icon.svg  README.md
```

### 2.2 磁盘位置（按 docs/98 三条规则）

| 内容 | 位置 | 理由 |
|---|---|---|
| 启用状态 | `~/.cc-panes/config.toml` 的 `[plugins]`（`AppSettings.plugins`） | 本机本用户的应用配置；内置插件没有目录，不能学 BlackCatCrazy 用 `.disabled` 标记文件 |
| 已安装外部插件（第二期） | `~/.cc-panes/plugins/<id>/`，安装先落 `.staging-<token>/` 再 `rename`（同 docs/97 技能安装） | 机器级，永不进 git |
| 目录源列表（第二期） | `~/.cc-panes/plugins/_market/sources.json` | 照搬 `feat_market.rs` 的 `sources.json` |
| 工作空间级启用集（第二期，仅技能 / MCP） | `~/.cc-panes/workspaces/<name>/plugins.json` | 「这一组项目共用」默认放工作空间层 |
| 项目推荐插件（第三期，可选） | `<project>/.ccpanes/plugins.json`（只放 id 列表，可提交） | 换个人 clone 下来仍有意义，符合 docs/98 判据 |

第一期新增 `AppPaths::plugins_dir()`（`cc-panes-core/src/utils/app_paths.rs`），只建路径方法，先不建目录。

### 2.3 目录源（catalog）

- 格式**完全沿用** `blackcatcrazy-plugins/index.json`：`{"format":1,"title":..,"plugins":[{id,name,version,description,author,license,icon,permissions,platforms,engines,homepage,download:{url,bytes,sha256}}]}`。
- 扩展两个可选键（旧解析器会忽略，向后兼容）：
  - 条目级 `"builtin": true`，没有 `download`；
  - 顶层 `"sections": [{"id":"hot","title":"热门","ids":[..]}, {"id":"new","title":"新品推荐","ids":[..]}]`，对应参考截图里的分区。
- 第一期：目录随 App 打包，放在 `src-tauri/src/services/plugin_catalog/catalog.json`（同 `mcp_market/curated.json` 的做法），只含内置插件。
- 第二期：默认源为一个新的公开插件仓库的 `index.json`（直接复制 `blackcatcrazy-plugins/scripts/pack.py`）。下载规则照搬 `feat_market.rs`：只允许 https、本地源可用 `file://` / `127.0.0.1`、zip 上限 30 MB、先校验 sha256、条目坏了跳过并记 warnings。

## 3. UI 插件怎么跑

| 方案 | 做法 | 安全 | 结论 |
|---|---|---|---|
| A. 内置插件 | 代码在 `web/` 里，用 `React.lazy` 分包；插件只是开关 + 注册表 | 无新增攻击面 | **第一期** |
| B. 主 WebView 内的沙盒 iframe（BlackCatCrazy 的 `sandbox="allow-scripts"` + postMessage `window.bcc`） | 需要 `frame-src` 指向自定义协议 | 当前 CSP（`tauri.conf.json`）没有 `frame-src`；Tauri 在部分平台会给子 frame 也注入 IPC 脚本；而 App 命令不受 capability 管控 | **不采用** |
| C. 独立 WebView / 窗口 + 专属 capability | 插件网页在单独的 webview 里，capability 学 `capabilities/island.json`，只给 `core:event:default`；宿主侧一个 `plugin_bridge` 命令按 `permissions` 校验后转发 | 隔离由 Tauri 的窗口边界保证，宿主可审计 | **第三期备选**，有真实第三方 UI 需求时再做 |

BlackCatCrazy 能用 iframe，是因为它的宿主是浏览器页面 + 本地 HTTP 服务，服务端还会再查一遍权限；CC-Panes 的宿主是带全权 IPC 的 Tauri WebView，前提不一样，不能照搬。

## 4. 短剧制作台迁移（第一期核心）

### 4.1 前端注册表（新增）

`web/plugins/builtinPlugins.ts`：

```ts
export interface BuiltinPluginDef {
  id: "drama-studio";              // 以后加 "library-space" 等
  icon: LucideIcon | ComponentType; titleKey: string; descKey: string;
  view?: { mode: AppViewMode };     // 主视图贡献
}
```

`web/lib/pluginGate.ts`：照搬 `web/lib/experimentalGate.ts` 的「零依赖函数指针」模式（那里的注释写明了直接 import settings store 会循环依赖），由 `useSettingsStore.ts` 注册 `registerPluginGate(...)`。
`web/hooks/usePluginEnabled.ts`：`useSettingsStore(s => s.settings?.plugins?.enabled?.[id] === true)`。

### 4.2 逐文件改动

| 文件 | 改动 |
|---|---|
| `cc-panes-core/src/models/settings.rs` | 新增 `PluginSettings { enabled: BTreeMap<String,bool> }`，挂到 `AppSettings.plugins`（`#[serde(default)]`）。`ExperimentalSettings.drama_studio` 改为 `#[serde(default, rename="dramaStudio", skip_serializing)] legacy_drama_studio: Option<bool>`：只读不写。新增 `SETTINGS_VERSION_PLUGINS = 2`，在 `merge_missing_defaults` 里：`if settings_version < 2 { if legacy.unwrap_or(default_experimental_flag()) { plugins.enabled.insert("drama-studio", true) } settings_version = 2 }`。补测试：老配置 `dramaStudio=true` 迁移后为开；缺键时随构建默认值；已迁移过的配置再次加载不被覆盖 |
| `web/types/settings.ts` | `ExperimentalSettings` 删掉 `dramaStudio`；新增 `PluginSettings`，`AppSettings.plugins` |
| `web/stores/useSettingsStore.ts` | `DEFAULT_EXPERIMENTAL_SETTINGS` 删 `dramaStudio`；默认 `plugins: { enabled: {} }`；默认 `settingsVersion` 由 1 改 2，**必须与 Rust 同步**，否则前端整份回写时会把版本写回 1；注册 pluginGate |
| `web/stores/useActivityBarStore.ts` | `GATED_MODES` 改成 `{ dramaGen: { plugin: "drama-studio" } }`，`gatedModeEnabled` 改读 `pluginEnabled`；`toggleDramaGenMode` 逻辑不变 |
| `web/components/layout/MainViewSwitcher.tsx` | `useExperimentalFeature("dramaStudio")` → `usePluginEnabled("drama-studio")`；`gatedModeBlocked` 回退到 panes 的逻辑保留（persist 里残留 `dramaGen` 也能兜住） |
| `web/components/ActivityBar.tsx` | drama 入口改为遍历 `BUILTIN_PLUGINS.filter(p => p.view && enabled)` 渲染，图标沿用 `SolidClapperboard` |
| `web/components/settings/ExperimentalSection.tsx` | `FEATURES` 删 dramaStudio；加一行「短剧制作台已移到 资源库 → 插件」 |
| `web/i18n/locales/{zh-CN,en}/settings.json` | 删 `experimental.dramaStudio*`；新增 `resourceLibrary.plugins` 和 `plugins.*` 文案 |
| 测试 | `ActivityBar.test.tsx`、`MainViewSwitcher.test.tsx`、`web/test/utils/testData.ts` 从 experimental 改成 plugins fixture |

不改：`web/components/drama/*`、`dramaService.ts`、`drama_commands.rs`、`src-tauri/src/lib.rs` 的命令注册、`db.rs` 的建表。插件化只动「入口」，不动功能。

## 5. 资源库「插件」页

### 5.1 导航与路由

- `web/types/resourceLibrary.ts`：`ResourceSection = "mcp" | "skills" | "plugins"`。这一处改动会自动连到 `openResourceLibrary`、`settingsWindowService.ts` 的 action 类型和 `useSettingsWindowBridge.ts`。
- `ResourceLibrarySidebar.tsx`：`SECTIONS` 加 `{ id: "plugins", icon: Puzzle, labelKey: "resourceLibrary.plugins" }`。参考截图里「已安装」列表挂在导航下方，第一期插件少，先做在页内（见下），侧栏不放。
- `ResourceLibraryPage.tsx`：`if (section === "plugins") return <PluginsLibraryPage />`（lazy）。

### 5.2 页面布局（照参考截图）

```
┌ 插件 ─────────────────────────────── [搜索插件…] [↻] [添加 ▾] ┐
│ 一行说明（插件能加主视图、技能、MCP；停用不删数据）             │
│ 已安装 (n)   ← 行：图标 名称 版本 一句话描述 [开关] [⋯]          │
│ 热门 / 新品推荐 / 全部   ← catalog.sections，两列网格           │
│   行：图标 名称 描述 [安装/已安装]                               │
└────────────────────────────────────────────────────────────────┘
点击行 → 右侧详情（复用 SkillDetailPanel 的抽屉形态）：权限、贡献点、主页、版本
```

- 刷新、「添加」（从文件夹 / 从地址装）第一期置灰或隐藏，第二期启用。
- 内置插件在「已安装」里显示「内置」标签，只有开关，没有卸载。
- 复用：`SkillRow.tsx`（行布局 + `SkillRowTag` 标签，加 `builtin` 一种 tone）、`SkillDetailPanel.tsx`（详情抽屉）、`SkillDiscoverSection.tsx` / `McpMarketSection.tsx` 的分区与两列网格写法、`components/ui/switch`、`libraryChrome.tsx` 的 `openExternalUrl`。插件的启用是全局的，不按启动档，所以**不用** `ProfileChips` / `ScopeSelect`（第二期技能 / MCP 贡献再按工作空间作用域接 `useResourceScope`）。
- 新文件：`web/components/resources/PluginsLibraryPage.tsx`、`PluginRow.tsx`（如果 `SkillRow` 能通过 props 覆盖就不建）、`pluginLibraryModel.ts`（catalog + 已装 + 启用状态合并、搜索过滤，纯函数配同目录测试）。
- 第一期数据：前端用 `BUILTIN_PLUGINS` + 后端 `list_plugin_catalog` 命令（读打包的 `catalog.json`）合并；启用 / 停用走现有 `settingsService` 保存 `plugins.enabled`。

## 6. 路线、风险、待定

### 第一期（最小可发版）

1. Rust：`settings.rs`（PluginSettings + 迁移 + 测试）；`app_paths.rs`（`plugins_dir`）；`src-tauri/src/services/plugin_catalog/{mod.rs,catalog.json}` + `src-tauri/src/commands/plugin_commands.rs`（`list_plugin_catalog`），在 `commands/mod.rs`、`lib.rs` 注册。
2. 前端基础：`web/plugins/builtinPlugins.ts`、`web/lib/pluginGate.ts`、`web/hooks/usePluginEnabled.ts`、`web/services/pluginService.ts`、`web/types/plugin.ts`。
3. 短剧迁移：按 §4.2 的表改。
4. 资源库：`resourceLibrary.ts`、`ResourceLibrarySidebar.tsx`、`ResourceLibraryPage.tsx`、`PluginsLibraryPage.tsx`、`pluginLibraryModel.ts(+test)`、两份 i18n。
5. 验收：老配置 `dramaStudio=true` 升级后入口还在；release 新装默认看不到短剧入口，在 资源库 → 插件 打开后出现；关掉时如果正停在 dramaGen，自动退回 panes。

### 第二期：外部数据型插件
`~/.cc-panes/plugins/<id>/` 安装、卸载、更新（照搬 BlackCatCrazy 的 stage → 校验 → rename）。`skills` 贡献并进 `skill_mount_paths_for_profile`（`terminal_service.rs`），和 builtin、工作空间技能并列；Codex 并进 `skills.config`。`mcpServers` 贡献在安装时物化成共享 MCP 条目（带 `provenance: plugin:<id>`），卸载时一并删除。远程目录源 + `sections`；`settings` Schema 表单。

### 第三期：沙盒 UI 插件（视需求）
§3 方案 C；`permissions` 逐条确认；`plugin_bridge` 白名单命令。

### 风险
- **settingsVersion 双端不同步**：前端默认值写死了 1（`useSettingsStore.ts`），只升 Rust 不升前端，迁移后会被回写成旧版本，下次启动重复迁移。
- **字段删除与读取冲突**：`drama_studio` 不能直接删，迁移要读它；用 `skip_serializing` 保留一个版本，下个版本再删。
- **ActivityBar 正在被并行修改**（最近的提交改了图标），合并时注意冲突。
- **内置插件和实验开关两套门禁并存**：`librarySpace` 仍是实验开关；之后再新增功能时要定好口径，免得同一个功能两边都能开。
- **Tauri IPC 暴露面**：任何「先在 iframe 里跑跑看」的捷径都会让第三方代码拿到全权 IPC，第三期之前不接受外部网页 UI。

### 待用户拍板（≤5）
1. 资料空间（`librarySpace`）是否也在第一期一起转成内置插件？（建议：是，入口模式相同，顺手就能做）
2. 默认是否开启短剧制作台？建议：Release 新装默认关（与现在一致），Dev 默认开。
3. 插件仓库：新建独立的 CC-Panes 插件仓库，还是在 `blackcatcrazy-plugins` 里用 `engines` 区分宿主共用一个源？（建议：分开，权限模型不同）
4. 第二期的插件技能 / MCP：按启动档开关（同技能、MCP 现状），还是装上就对所有会话生效？（建议：按启动档，与 docs/109 一致）
5. `experimental.skillMarket` 在 Rust / TS 里还留着，但前端已经没有任何地方用它当门禁，是否借这次一并删掉？
