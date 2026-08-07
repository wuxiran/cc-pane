# 配色与界面形态验收记录

Date: 2026-08-06
Base revision: `498744b`
Change: `appearance-theme-shape`

## main 合入复核（2026-08-07）

形态能力已按完整跨层链路移植到 `main`（执行前 `e43aa9d`），没有用 zjkj 工作区旧文件覆盖 PR #55 之后的实现。复核同时保留了 `main` 已有的主题 draft 同步逻辑，并补充“外部重置同时更新配色和形态实时预览”的回归测试。

| 范围 | 命令 | 结果 |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | 通过 |
| 形态目录、CSS、表面覆盖、设置页与搜索 | `npm run test:run -- web/theme/themeShapes.test.ts web/theme/themeShapeCss.test.ts web/theme/themeShapeCoverage.test.ts web/components/settings/ThemeSection.test.tsx web/components/settings/settingsRegistry.test.ts` | 47/47 通过 |
| Store、设置服务与生命周期 | `npm run test:run -- web/stores/useThemeStore.test.ts web/stores/useSettingsStore.test.ts web/services/settingsService.test.ts web/hooks/useAppLifecycle.order.test.tsx` | 43/43 通过 |
| 功能提示与状态栏 | `npm run test:run -- web/components/tips/featureTipRegistry.test.ts web/components/tips/FeatureTip.test.tsx web/components/tips/FeatureTips.test.ts web/components/StatusBar.test.tsx` | 35/35 通过 |
| 前端完整回归 | `npm run test:run` | 通过 |
| 生产构建 | `npm run build` | 通过（仅仓库既有告警） |
| Rust 格式 | `cargo fmt --all -- --check` | 通过 |
| Rust 形态定向测试 | `cargo test -p cc-panes-core theme_shape -- --nocapture` | 4/4 通过 |
| Rust core 完整回归 | `cargo test -p cc-panes-core` | 1084 通过，3 个环境/人工用例忽略 |
| Diff 空白与冲突标记 | `git diff --check` | 通过 |

本轮本地 Vite 服务可用，但浏览器运行时没有可连接实例，因此仍未执行 Windows WebView2 × 壁纸的 36 组截图验收。该项继续保持未完成，不能由自动化测试替代。

## 自动验证

| 范围 | 命令 | 结果 |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | 通过 |
| 形态设置页 | `npm run test:run -- web/components/settings/ThemeSection.test.tsx web/components/settings/settingsRegistry.test.ts` | 14/14 通过 |
| 形态 CSS 与色值护栏 | `npm run test:run -- web/theme/themeShapeCss.test.ts web/test/colorGuard.test.ts` | 13/13 通过 |
| 功能提示与状态栏 | `npm run test:run -- web/components/tips/featureTipRegistry.test.ts web/components/tips/FeatureTip.test.tsx web/components/tips/FeatureTips.test.ts web/components/StatusBar.test.tsx` | 35/35 通过 |
| 前端回归 | `npm run test:run -- --exclude web/test/lineRatchet.test.ts` | 通过 |
| 生产构建 | `npm run build` | 通过 |
| Rust 格式 | `cargo fmt --all -- --check` | 通过 |
| Rust 形态持久化 | `cargo test -p cc-panes-core theme_shape -- --nocapture` | 4/4 通过 |
| Diff 空白与冲突标记 | `git diff --check` | 通过 |

`npm run test:run` 仍有一条仓库基线失败：`web/test/lineRatchet.test.ts` 要求 `ProviderFormPanel.tsx <= 701` 行，但 `HEAD` 中该文件已是 732 行。本变更未修改该文件或基线；排除该已失效基线后，其余前端回归全部通过。

`npm run build` 仅输出仓库已有的 CSS `var(...)`、循环导出、动态/静态导入与 chunk 大小告警，没有构建错误。

## Designer Review

【Designer Review · 配色与界面形态】

用户路径：清晰。现有“主题”入口内先选配色、再选形态；设置搜索和功能提示都能直达形态区。
认知负荷：中。6 个配色加 6 个形态需要理解两个概念，但分区标题、职责说明和结构预览已将它们分开。
错误/恢复：非法值和旧配置回落 Soft；“恢复默认形态”有完成 toast；背景模糊不可用时给出中性降级说明。
反馈/愉悦：点击同帧更新形态，选中态同时使用边框、勾选和 `aria-pressed`。
一致性：沿用当前 Settings、Button、toast、功能提示和设置导航模式，符合 `STRATEGY.md` 的外观层边界。

Top 3 改动：

1. 窄宽设置面板中将形态说明与恢复按钮改为上下排列，已实施。
2. 非快捷键型提示不显示“重新绑定快捷键”，已实施。
3. 发布前按 36 组矩阵完成 Windows WebView2 与壁纸签署，待人工验证。

## QA Review

【QA Review · 配色与界面形态】

Happy path 测试存在：六值目录、双端默认/非法值归一化、持久化往返、首帧缓存、子窗口隔离、即时切换、独立组合、搜索、恢复、提示动作和 P0 表面覆盖均有自动断言。

关键缺失边界：

- [ ] 环境 · 36 组在 Windows WebView2 的可读性、重叠与纹理边界 · 概率中 · 影响高
- [ ] 环境 · Glass/Carbon 在有壁纸、无壁纸和不支持 blur 时的真实 WebView2 降级 · 概率低 · 影响中
- [ ] 时序 · 桌面端保存后立即强制退出再启动的实机恢复 · 概率低 · 影响高
- [ ] 异常 · 设置写入失败时即时预览与下次加载已落盘值的区分 · 概率低 · 影响中

推荐新增测试（排序）：

1. `desktop_shape_matrix_has_no_overlap` - 覆盖 36 组桌面视觉与内容画布边界。
2. `shape_persists_across_forced_restart` - 覆盖桌面真实落盘与重启恢复。
3. `glass_falls_back_without_backdrop_filter` - 覆盖真实 WebView2 的 blur 降级和提示。

值得手动一次性验证的场景：浅色 + Carbon、深色 + Glass、窄窗口 + 英文长文案、终端选区/光标、Monaco/Mermaid、弹窗、输入框、壁纸视频和恢复后重启。

## 独立评审

T6/T7 经子代理合并评审，结论为 PASS WITH NITS，无严重或主要问题。评审提出的恢复提示、blur 降级、独立组合测试初始态以及无快捷键提示的误导入口均已修正，定向回归通过。

## 需求与不变量对照

- 六种配色和六种形态保持独立；切换任一维不改写另一维。
- Soft 为缺字段和非法值的默认形态，保留原有视觉 token。
- 未修改 `TerminalView`、PTY/xterm、Monaco、Mermaid、窗格尺寸、字体、终端主题或状态语义。
- Glass/Carbon 只消费现有配色 token；色值护栏通过，无新依赖。
- ccchan、popup 和 WebGL 诊断窗口保持 Soft，不回写主窗口缓存。
- 中英文设置、搜索、功能提示和 Changelog 同步。

## 未完成的人工门禁

当前会话没有可连接的内置浏览器或桌面视觉工具，因此未执行 `docs/shape-visual-checklist.md` 的 36 组 Windows WebView2/壁纸矩阵，也没有截图证据。这一项不能以 jsdom 或构建成功替代。
