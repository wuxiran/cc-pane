# cc-pane-new_zjkj → main 功能合并清单

## 2026-08-07 执行复核（本节结论优先）

原清单的方向基本正确，但有两项关键判断已经过时或不完整，不能按原步骤直接执行：

1. `498744b` 已经是当前 `main`（执行前 `e43aa9d`）的祖先，`git merge-base --is-ancestor 498744b HEAD` 返回成功。Claude Provider `--settings` 注入已存在，且 `277f76e` 又补充了陈旧文件清理和 settings 键语义测试，因此没有重复 cherry-pick。
2. “形态”不是只合 9 个 untracked 文件即可完成。那 9 个文件主要是目录定义、测试和文档；可用功能还依赖 Rust/TypeScript 设置契约、设置持久化、主题 Store、首帧恢复、特殊窗口隔离、CSS token、核心表面标记、设置 UI、搜索、i18n 和功能提示。只合 9 个文件会得到无法在界面选择和持久化的半成品。

实际执行策略：

- 保留 `main` 已有的按终端使用量、状态栏、终端恢复和 daemon 实现。
- 从 zjkj 工作区 50 个 modified 文件中只提取“形态”相关 hunk，不整体覆盖任何文件，也不引入上下文用量、终端或 daemon 的旧实现。
- 合入 6 种形态的完整设置、运行时、样式、UI、搜索、提示、测试和文档链路。
- 保留并扩展 `main` 已有的主题 draft 同步修复：外部重置或重新加载设置时，配色与形态都会更新实时预览。
- 未处理执行前工作区已经存在的异常删除项和无关 untracked 文件。

当前环境验证：

- `npx tsc --noEmit`：通过。
- `npm run test:run`：完整前端回归通过。
- `npm run build`：通过，仅有仓库既有构建告警。
- `cargo fmt --all -- --check`：通过。
- `cargo test -p cc-panes-core`：1084 通过，3 个环境/人工用例忽略。
- `git diff --check`：通过。
- Windows WebView2 × 壁纸视觉矩阵：仍待人工验收；本轮没有可连接的浏览器实例，不能用 jsdom 或构建结果代替。

以下内容保留为原始扫描记录；其中“9 文件即完整形态功能”“Provider 仍待 cherry-pick”和原执行命令均已由本节更正。

> **生成时间**：2026-08-07
> **来源分支**：`F:\C26\demo\cc-pane-new_zjkj` 的 `dev_zhengjunkj`（HEAD `498744b`）
> **目标分支**：`F:\C26\demo\cc-pane-new` 的 `main`（HEAD `e43aa9d`，v0.12.0-beta.1 后续）
> **比较基线**：`cc-pane-new_zjkj` 的 `origin/main`（merge-base = `0591742`，v0.11.10 之后第一个 commit）
> **合并主体**：zjkj 工作区未提交改动（167 文件，+11090 / -604 行）+ zjkj 独有的 1 个 commit

---

## 一、扫描结论速览

| 来源 | 数量 | 是否合并到 main |
|---|---|---|
| zjkj 11 个 commit 已通过 PR #55 进入 main | 10 个 | ✅ 已合并，无需处理 |
| zjkj 独有的 commit | 1 个 | ❌ **待合并** |
| zjkj 工作区存在的"形态"完整新能力 | 9 个 untracked 文件 | ❌ **待合并** |
| zjkj 工作区与 main 重叠的 50 modified | 50 个 | ⚠️ 与 main 已有版本并存，需评估 |

**两个真正需要合并的「独立块」**：

1. **「形态」**（Interface Shape）—— 6 种界面形态（soft / slab / sharp / glass / panel / carbon），与配色正交
2. **「Claude Provider --settings 注入」**（commit `498744b`）—— 让 Managed Provider 注入的 env 不被 user-level `settings.json` 覆盖

---

## 二、合并目标 1：形态（Interface Shape）

### 2.1 功能描述

把"形态"作为和"配色"**正交**的第二维外观设置。配色控制背景/文字/强调色/状态色，形态控制圆角/边界/阴影/表面材质。

**6 种形态**：

| code | label | 特性 |
|---|---|---|
| `soft`（默认） | Soft | 透传/装饰/平面 三性皆否 |
| `slab` | Slab | 厚板 |
| `sharp` | Sharp | 平面（flat） |
| `glass` | Glass | 透传（translucent） |
| `panel` | Panel | 平面（flat） |
| `carbon` | Carbon | 透传 + 装饰（decorative） |

**与配色可任意组合**：例如"午夜蓝"+"Soft"、"午夜蓝"+"Sharp"、"午夜蓝"+"Glass"。

### 2.2 文件清单（9 个 untracked）

| 文件 | 行数 | 用途 |
|---|---|---|
| `web/theme/themeShapes.ts` | 78 | 6 种形态的代码 / 标签 / 描述 / 特性定义，含 `canonicalThemeShape` 容错函数 |
| `web/theme/themeShapes.test.ts` | — | 单元测试：6 值目录、非法值归一化 |
| `web/theme/themeShapeCoverage.test.ts` | — | 覆盖度测试：所有形态 + 描述键存在 |
| `web/theme/themeShapeCss.test.ts` | — | CSS 注入测试：形态 StyleSheet 跨端一致 |
| `docs/84-appearance-theme-shape-copy.md` | 9.1k | **产品文案评审稿**（中英文案、设置页层级、SOFT/SLAB/SHARP/GLASS/PANEL/CARBON 命名） |
| `docs/PRDs/appearance-theme-shape.md` | 14k | 完整 PRD（含 i18n 字符串、设置面板 UI 规格、特性矩阵） |
| `docs/shape-verification-record.md` | 4.8k | 验收记录（自动验证 / Designer Review / QA Review / 缺失边界） |
| `docs/shape-visual-checklist.md` | 4.0k | 36 组 Windows WebView2 × 壁纸矩阵的人工验收清单 |
| `docs/PRDs/appearance-theme-shape-tasks.md` | 6.5k | OpenSpec 任务清单（同 STRATEGY 中 OpenSpec 流程） |

### 2.3 验收状态（已自测通过）

来自 `docs/shape-verification-record.md`：

- ✅ `npx tsc --noEmit` 通过
- ✅ `npm run test:run` 形态相关 4 文件 35+ 测试全绿
- ✅ `npm run test:run` 全前端回归通过（除已知 `lineRatchet.test.ts` 失效基线）
- ✅ `npm run build` 通过
- ✅ `cargo fmt --all -- --check` 通过
- ✅ `cargo test -p cc-panes-core theme_shape` 4/4 通过
- ✅ `git diff --check` 通过
- ✅ Designer Review + QA Review + 独立评审全 PASS WITH NITS
- ⚠️ **未完成**：36 组 Windows WebView2 × 壁纸矩阵人工验收（缺乏桌面浏览器/视觉工具）

### 2.4 边界 / 不变量

来自 `docs/84-appearance-theme-shape-copy.md` 和 `docs/shape-verification-record.md`：

- 形态不改变布局、字号、终端主题、字体
- 缺字段 / 非法值默认回落 `soft`
- 不修改 `TerminalView` / PTY/xterm / Monaco / Mermaid / 窗格尺寸
- Glass/Carbon 只消费现有配色 token，色值护栏通过，**无新依赖**
- ccchan / popup / WebGL 诊断窗口保持 `soft`，不写回主窗口缓存

### 2.5 风险等级

🟢 **低** —— 纯外观设置，独立的代码模块，与现有体系正交，不动核心数据流。

---

## 三、合并目标 2：Claude Provider 通过 --settings 文件注入

### 3.1 功能描述

**问题**：Managed Provider 的环境变量（API key / base URL / model）原本只走进程 env。Claude CLI 启动后会读 user-level `settings.json`，user-scoped 的 `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / 模型选择会**覆盖** Managed 值，导致用户配的第三方 Provider 被悄悄切回 Anthropic 直连。

**修复**：把 Managed 的 env 写成一个临时 settings 文件（`<data_dir>/claude-provider-<sessionId>.json`），用 `--settings <path>` 让 CLI 用此文件覆盖 user-level env。

**代码路径**（唯一 commit `498744b`）：

1. `cc-cli-adapters/src/claude.rs` —— `generate_provider_settings`：从 `adapter_options[__ccpanesProviderEnv]` 取 Managed env JSON；显式 reset 全部 routing 相关 env key（缺失补空串）；把 model id 写入 5 个 key：`ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL`；原子写入文件；`cleanup_stale_provider_settings` 清理 >1h 陈旧文件。
2. `cc-cli-adapters/src/lib.rs` —— 新增常量 `MANAGED_PROVIDER_ENV_OPTION = "__ccpanesProviderEnv"`（internal，含 credentials，**永不日志、永不进 CLI args**）。
3. `cc-cli-adapters/src/claude.rs` `build_command` —— 在 `--dangerously-skip-permissions` 前追加 `--settings <path>`。
4. `cc-panes-core/src/services/terminal_service.rs` —— 在 `cli_tool == Claude && ProviderMode::Managed` 时把 provider env JSON 注入 `adapter_options[MANAGED_PROVIDER_ENV_OPTION]`。
5. `cc-panes-core/src/services/provider_resolver.rs` —— `managed_provider_conflict_env_keys` 加 5 个 model env key，让冲突检测覆盖 model 字段。

### 3.2 文件清单

| 文件 | 改动 |
|---|---|
| `cc-cli-adapters/src/claude.rs` | +122 行 |
| `cc-cli-adapters/src/lib.rs` | +4 行 |
| `cc-panes-core/src/services/provider_resolver.rs` | +11 行 |
| `cc-panes-core/src/services/terminal_service.rs` | +部分（已混杂其他 commit） |

### 3.3 验收状态（来自 PR_DESCRIPTION.md）

- ✅ `ClaudeAdapter.build_command_overrides_user_routing_with_managed_provider_settings` —— 检查生成的 `settings.json` 含 base URL / model / subagent_model，`ANTHROPIC_AUTH_TOKEN` 被清空；args 里无 provider secret 泄露
- ✅ `provider_resolver.managed_conflict_lists_are_cli_scoped_and_never_apply_to_shell` —— `ANTHROPIC_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` 加入冲突列表
- ✅ Rust 单元测试（含 cc-cli-adapters / provider_resolver）
- ✅ i18n 中英文案齐备

### 3.4 风险等级

🟡 **中** —— 修改了 CLI 启动参数与 settings.json 注入路径，会影响所有 Claude 启动。但写入路径有 1 小时 TTL 自动清理，credentials 严格不日志。

---

## 四、合并目标 3（可选）：使用量按终端独立

### 4.1 功能描述

**已有版本**：main 通过 PR #55 已经实现了：
- `useContextUsageStore` 改 `Map<sessionId, ContextUsageEntry>`
- `useContextUsagePoller` 接受外部 `terminalContext`，非激活面板也能轮询
- `ContextUsageIndicator` 接受外部 `terminalContext` + 紧凑 tooltip
- `StatusBar` 用 `showContextUsage` 控制全局指示器

**zjkj 工作区版本**：zjkj 工作区里也有同名的 `useContextUsageStore.ts` / `useContextUsagePoller.ts` / `ContextUsageIndicator.tsx` 等改动（+561 / +142 行），但**实现细节可能与 main 的 PR #55 重做版不一致**。

### 4.2 决策选项

- (a) **保留 main 已有版本**（无需操作）
- (b) **用 zjkj 工作区版本覆盖**（需逐文件对比）
- (c) **逐文件对比挑更好的实现**

### 4.3 建议

🟡 **建议先做 (a)**：除非你明确知道 zjkj 版本在某方面更优。CLAUDE.md gotcha 强调"已合并到 main 的功能不要重新改"，避开回归风险。

---

## 五、合并目标 4（评估中）：zjkj 工作区 50 modified 文件

zjkj 工作区有 50 modified 文件与 main 高度重叠，主要类别：

| 类别 | 关键文件 | 与 main 冲突点 |
|---|---|---|
| 状态栏 | `web/components/StatusBar.tsx` / `.test.tsx` | 与 PR #55 重新实现并存 |
| 主题设置 | `web/components/settings/ThemeSection.tsx` | PR #55 重做，含形态前的旧版本 |
| 设置注册 | `web/components/settings/settingsRegistry.ts` | 与 PR #55 并存 |
| 功能提示 | `web/components/tips/FeatureTip.tsx` / `featureTipRegistry.tsx` | 与 PR #55 并存 |
| 终端 Tab | `web/components/panes/TabBar.tsx` / `TerminalTabContent.tsx` | 与 PR #55 重做并存 |
| 后端服务 | `cc-panes-core/src/services/usage_stats_service.rs` / `terminal_service.rs` | 与 PR #55 + v0.12.0-beta.1 之后的测试冲突 |

### 5.1 风险等级

🔴 **高** —— 这是"重做 vs 原版"差异，直接 apply 会引入冲突与回归。

### 5.2 建议

🟢 **强烈建议全部放弃**（保持 main 已合并状态）。

---

## 六、合并执行计划建议

### 6.1 推荐顺序

1. **先合「形态」**（9 个 untracked）—— 独立新能力，无冲突，直接 apply
2. **再合「Claude Provider --settings 注入」**（1 个 commit `498744b` cherry-pick）—— 唯一未在 main 上的 commit
3. **zjkj 工作区 50 modified** —— 全部 discard（保留 main） —— 除非你明确指出某个文件的 zjkj 版本更好

### 6.2 形态合并的具体步骤

```bash
# 在 zjkj 仓库
cd F:/C26/demo/cc-pane-new_zjkj

# 1. 先把形态相关的 9 个文件单独 commit
git add web/theme/themeShapes.ts \
        web/theme/themeShapes.test.ts \
        web/theme/themeShapeCoverage.test.ts \
        web/theme/themeShapeCss.test.ts \
        docs/84-appearance-theme-shape-copy.md \
        docs/PRDs/appearance-theme-shape.md \
        docs/shape-verification-record.md \
        docs/shape-visual-checklist.md \
        docs/PRDs/appearance-theme-shape-tasks.md
git commit -m "feat(theme): 配色与形态 - 6 种界面形态（soft/slab/sharp/glass/panel/carbon）"

# 2. 推送到 zjkj 远程分支
git push origin dev_zhengjunkj

# 3. 在主仓库 cherry-pick 此 commit
cd F:/C26/demo/cc-pane-new
git fetch origin dev_zhengjunkj
git checkout -b merge/interface-shape-from-zjkj
git cherry-pick <新 commit sha>
npm run test:run -- web/theme/themeShapeCss.test.ts web/theme/themeShapes.test.ts
cargo test -p cc-panes-core theme_shape
git push origin merge/interface-shape-from-zjkj
# 开 PR：main ← merge/interface-shape-from-zjkj
```

### 6.3 Claude Provider --settings 注入的具体步骤

```bash
# 在 zjkj 仓库
cd F:/C26/demo/cc-pane-new_zjkj

# 1. 由于此 commit 是 zjkj 独有，可以直接 cherry-pick
#    但要注意：zjkj 在 498744b 之后还有 zjkj merge-base 内的其他 commit
#    先 rebase 到最新 main
git fetch origin
git rebase origin/main
# 处理可能的冲突

# 2. cherry-pick 唯一的 commit
git checkout -b cherry-pick/claude-provider-settings origin/main
git cherry-pick 498744b

# 3. 跑测试
cd cc-cli-adapters && cargo test
cd ../.. && cargo test -p cc-panes-core
cargo clippy --workspace -- -D warnings

# 4. 推送到主仓库
git push origin cherry-pick/claude-provider-settings
# 开 PR
```

---

## 七、待用户确认

请告知以下决策：

1. **形态**（9 文件）—— 直接合，对吗？
2. **Claude Provider --settings 注入**（1 commit `498744b`）—— cherry-pick，对吗？
3. **「使用量按终端独立」** —— 用 main 已有版本（什么都不做），还是用 zjkj 工作区版本？
4. **zjkj 工作区 50 modified** —— 全部 discard（保留 main），还是逐个看？

🤖 Generated with [Claude Code](https://claude.com/claude-code)
