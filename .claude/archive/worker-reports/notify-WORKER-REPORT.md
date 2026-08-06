# WORKER REPORT - 0113 通知 UI

## 1. 状态

IMPLEMENTED

- Phase 1 / 2 / 3 均已实现并各自独立提交。
- 共改动 25 个受版本控制的代码/测试文件；`WORKER-REPORT.md` 未提交。
- 未 push，未合并，未运行 `cargo test --workspace`。

提交：

- `15205bf feat(notify): 实现共享打扰闸门`
- `a853b7a feat(update): 新增版本更新卡片`
- `c23a8c1 feat(tips): 新增低频功能提示`

## 2. 各 Phase 完成情况

### Phase 1 - 完成

- `web/lib/interruptGate.ts:38`：共享纯函数闸门，按规定顺序返回首个拒绝原因。
- `web/lib/interruptGate.ts:42`：复用 `isBusyStatus()`，并额外显式判断 `waitingInput`；未修改 `BUSY_STATUSES`。
- `web/lib/interruptGate.ts:97`：hook 每次检查读取真实 store 最新值，并提供有所有权保护的 occupy/release。
- `web/lib/interruptGate.test.ts`：14 项测试覆盖所有闸门、两种优先级方向、同类占用和全放行。

### Phase 2 - 完成

- `cc-panes-core/src/models/settings.rs:553`、`web/types/settings.ts`：新增 `[update]` 双侧模型，持久化 `notifyEnabled/skippedVersion/lastNotifiedAt`。
- `web/components/settings/GeneralSection.tsx:151`：设置 -> 通用新增“有新版本时提示”开关。
- `web/services/updaterService.ts:139`：拆出 `downloadAndInstallUpdate(update, onProgress)`，原生 ask 路径继续复用；安装前停止 Web/daemon，报告累计真实进度，最后 relaunch。
- `web/components/update/UpdateNotification.tsx:52`：实现开关、跳过版本和 24 小时静默判定。
- `web/components/update/UpdateNotification.tsx:83`：独立右下角非模态卡片；支持 changelog 降级/展开、稍后、跳过、点击瞬间重查闸门、重启风险二次确认、原地进度/错误/重试/下载页。
- `web/components/layout/AppShell.tsx:41`：全局 Sonner 仍为 `top-center`；更新卡独立挂载。
- StatusBar 原有更新入口保留，现有 `StatusBar.test.tsx` 8 项通过。

### Phase 3 - 完成

- `cc-panes-core/src/models/settings.rs:565`、`web/types/settings.ts`：新增 `[tips]` 双侧模型与持久化字段。
- `web/components/settings/GeneralSection.tsx:168`：设置 -> 通用新增“功能提示”开关。
- `web/components/tips/FeatureTip.tsx:27`：键位 chip 实时读取 binding 并经 `formatKeyCombo()` 格式化；空绑定隐藏 chip 并切换降级文案。
- `web/components/tips/featureTipRegistry.tsx:147`：首批 4 条为命令面板、布局选择器、迷你模式、统一启动器；均调用已注册 shortcut action handler；未加入 worktree 跳转。
- `web/components/tips/FeatureTips.tsx:40`：实现启动 5 分钟、前三会话、20 秒空闲、终端输入 30 秒、每会话 1 条、3 天间隔、连续两次忽略后 6 天间隔。
- `web/components/tips/FeatureTips.tsx:165`：更新抢占 tip 时不写 `seen/lastShownAt`，并允许本会话稍后重新候选。
- 复用 `GuidedDialog`；右栏仅用 CSS、语义 token 与 lucide 内联 SVG，动效使用 `motion-safe` / `motion-reduce`。

## 3. 没做到 / 没验证的部分

以下均未宣称通过：

1. 未用真实发布 feed 在 Windows 桌面端人工看到更新卡，也未执行真实下载安装、NSIS 替换和重启；单测使用 updater mock，只验证调用链和状态转换。
2. 未在本 worktree 启动 Windows Tauri 应用，因此没有在实际运行中的 agent 会话旁人工观察“不弹 -> 空闲后弹”。已用 `thinking/active/waitingInput` 注入覆盖闸门自动化测试。
3. “稍后 24 小时”“跳过当前版本/更高版本仍弹”通过纯函数与持久化 store 自动化验证，未做跨真实 24 小时或多次应用重启人工验证。
4. 下载失败的可读错误、重试和下载页通过组件自动化验证；未制造真实网络/发布清单故障。
5. 更新与 tip 的优先级和抢占逻辑通过闸门测试及源代码核对，未在真实 UI 中同时制造两者候选做人工观察。
6. 中英文 key parity 已验证；暗/亮色和 `prefers-reduced-motion` 仅完成 token/类名静态核对，未在 Windows WebView2 中逐项目视验收。
7. 未等待真实“第 4 次会话 + 启动 5 分钟”观察自动 tip；时机、频率、实时改键、解绑降级和实际 action handler 均由定向测试覆盖。
8. 未运行全量前端测试、全量构建、`cargo test --workspace` 或 Windows-host 验证，遵守派工边界。

docs/60 §4 七项对应结论：

- 1：卡片/调用链自动化通过；真实下载安装重启未验证。
- 2：busy 与 `waitingInput` 注入通过；真实 app 人工场景未验证。
- 3：规则自动化通过；真实时间跨度未验证。
- 4：全局开关测试通过，StatusBar 入口 8 项测试通过。
- 5：错误态/重试/下载页自动化通过；真实故障未验证。
- 6：共享占用与 update > tip 自动化通过；真实 UI 并发未验证。
- 7：中英 parity 通过；暗亮色/reduced-motion 仅静态核对，未目视。

## 4. 验证命令与结果

- `npm install`：exit 0，安装 554 packages。
- Phase 1：`npx tsc --noEmit` exit 0；`interruptGate.test.ts` 14/14。
- Phase 2：`npx tsc --noEmit` exit 0；`GeneralSection.test.tsx`、`updaterService.test.ts`、`UpdateNotification.test.tsx` 定向通过（最终分别 14/14、15/15、6/6）。
- Phase 3：`npx tsc --noEmit` exit 0；5 个定向文件 47/47。
- 最终聚合：11 个指定 Vitest 文件 75/75，exit 0。
- StatusBar 定向：`web/components/StatusBar.test.tsx` 8/8，exit 0。
- 前端护栏：i18n parity / colorGuard / noRawText / lineRatchet 共 7/7，exit 0。
- `CARGO_TARGET_DIR="$HOME/.cache/cc-book-target-notify" cargo fmt --all -- --check`：exit 0。
- `CARGO_TARGET_DIR="$HOME/.cache/cc-book-target-notify" cargo clippy --workspace -- -D warnings`：exit 0（无管道，约 1m25s）。
- `git diff --check f321bd1..HEAD`：exit 0。

## 5. Sonner position 冲突处理

采用独立定位组件：`UpdateNotification` 渲染 fixed `aside`，固定在右下角（`bottom-11 right-3`）。没有使用第二个 Toaster，也没有修改 `AppShell` 中现有 `<Toaster position="top-center">`，因此其他 toast 位置保持不变。

## 6. 公共文件与冲突预判

高概率公共冲突文件：

- `cc-panes-core/src/models/settings.rs`
- `web/types/settings.ts`、`web/types/index.ts`
- `web/stores/useSettingsStore.ts`
- `web/components/layout/AppShell.tsx`
- `web/components/settings/GeneralSection.tsx`、`GeneralSection.test.tsx`
- `web/components/settings/SettingsPaneContent.tsx`、`settingsDraft.ts`、`settingsRegistry.ts`
- `web/i18n/locales/en/settings.json`、`zh-CN/settings.json`
- `web/services/index.ts`、`web/services/updaterService.ts`、`updaterService.test.ts`
- `web/test/utils/testData.ts`

新增目录/文件冲突概率较低：`web/lib/interruptGate*`、`web/components/update/*`、`web/components/tips/*`。
