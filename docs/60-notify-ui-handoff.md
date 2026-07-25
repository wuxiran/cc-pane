# 交接任务：打扰闸门 + 版本更新卡片 + 功能提示

> 交接给另一个 Claude Code 实例执行。本文自洽——**读完本文 + 文中列出的两份设计文档即可开工**，不需要追问原上下文。
>
> 一句话：CC-Panes 的"主动告知用户"能力目前是零（更新提示只有 StatusBar 里一个 10px 小按钮），本任务补上这一层，并保证它**永远不打断正在干活的 agent**。

## 0. 你的边界（先读这条）

| 项 | 要求 |
|---|---|
| 工作方式 | **必须建独立 worktree**：`git worktree add -b 0113-notify-ui <路径> main`。主工作树 `D:\04_workspace_rust\cc-book` 有其他 agent 并行工作，**绝不在主树改动** |
| 不要碰 | `cc-panes-ctl/`、`cc-panes-daemon/`、`web/components/layoutbar/`（都有人在动）；`docs/58`、`docs/59`（是规格，不是任务载体，不要改） |
| 不要做 | 不要 push、不要合并回 main（由 leader 验收合并）；不要跑 `cargo test --workspace`（会被 daemon 文件锁阻塞） |
| 语言 | 中文注释与 commit message；UI 文案中英双语齐全（i18n） |

## 1. 规格文件（必读）

```
docs/59-update-notification.md    ← 版本更新卡片（主线）
docs/58-feature-tips.md           ← 功能提示（同批，共用闸门）
docs/46-frontend-styleguide.md    ← 前端风格宪法，UI 改动提交前必须对照
```

**为什么两件一起做**：docs/59 §4 明确要求两者共用同一套打扰闸门。分开做必然各建一套、互相叠加，用户会被两张卡同时糊脸。

## 2. 现状事实锚点（已核实，可直接信）

不要重新调研这些，直接用：

| 事实 | 位置 |
|---|---|
| 更新检查/安装**全都已实现** | `web/services/updaterService.ts`：`checkUpdateSilent()` 静默检查写 store；`triggerUpdate()` 真下载安装 + `relaunch()`；`getUpdateErrorHint()` 错误可读化 |
| 更新数据（含 changelog） | `web/stores/useUpdateStore.ts`：`available` / `version` / `body`（body 即 changelog，**可能为 null**） |
| 当前唯一被动露出 | `web/components/StatusBar.tsx:170-186`，10px 小按钮。**保留它**作为常驻入口 |
| toast 基建 | `sonner` 已装；`web/components/layout/AppShell.tsx:39` 挂了 `<Toaster position="top-center" …>` |
| **忙碌判定已存在** | `web/types/settings.ts:325-335`：`BUSY_STATUSES` / `isBusyStatus()`。**闸门必须复用它，不要自己重新定义"忙"** |
| 会话状态存储 | `web/stores/useTerminalStatusStore.ts`（`getStatus(sessionId)`） |
| 双栏弹窗壳（tips 用） | `web/components/onboarding/GuidedDialog.tsx`，已在 main，**复用不重造** |
| 快捷键真值（tips 用） | `settings.shortcuts.bindings[actionId]` + `formatKeyCombo()`（`web/stores/useShortcutsStore.ts`） |

⚠️ **`Toaster` 当前是 `position="top-center"`**。更新卡片要在**右下角**——不要粗暴改全局 position（会挪走其它既有提示）。二选一：给这张卡用独立定位的组件，或用 sonner 的 per-toast position（确认你用的版本支持）。做了哪种在报告里说明。

## 3. 实施顺序

### Phase 1：共享打扰闸门（先做，两件的地基）

新建 `web/lib/interruptGate.ts`（或同类位置），导出判定函数，供更新卡片与功能提示**共用**：

- [ ] **任一会话处于忙碌态则禁止打扰**——用 `isBusyStatus()` 遍历 `useTerminalStatusStore`；`waitingInput` 同样视为不可打扰（用户正被 agent 等着）；
- [ ] 应用启动后 < 30s 不打扰；
- [ ] 已有 modal/dialog 打开时不打扰（查 `useDialogStore`）；
- [ ] 全屏 / 迷你模式不打扰；
- [ ] **同一时刻只允许一个打扰**；优先级：更新提示 > 功能提示；
- [ ] 单元测试覆盖每一条闸门（这是最容易回归的部分）。

### Phase 2：版本更新卡片（docs/59，主线）

- [ ] 右下角非模态卡片：标题 `发现新版本 v{version}`，副标题 `v{当前} → v{新}`；
- [ ] 正文 `body`（changelog）截断 3-4 行 + 展开；**`body` 为 null 时降级为通用文案，不留空白块**；
- [ ] 主按钮「立即更新」→ 复用 `triggerUpdate()`；次按钮「稍后」；再一个「跳过此版本」；
- [ ] **下载/安装中卡片原地转进度态**（不要关掉再弹一个）；失败转错误态，给 `getUpdateErrorHint()` 的可读原因 + 「重试」+「去下载页」兜底；
- [ ] **重启前必须提示"将关闭并重启应用"**——用户可能正跑着 agent 任务；
- [ ] 频率与持久化（写 `~/.cc-panes/config.toml`，随 dev/release 数据目录隔离）：

```toml
[update]
notifyEnabled = true          # 设置→通用 开关，默认开
skippedVersion = "0.11.2"     # 跳过的版本，更高版本仍提示
lastNotifiedAt = "..."        # 每版本最多 1 次/天；点「稍后」静默 24h
```

> 配置项需要后端配合（Rust settings 模型 + TS 类型同步）。按 CLAUDE.md 的 7 步流程走，Rust/TS 两侧类型必须对齐。

### Phase 3：功能提示（docs/58，可分离）

若时间/上下文不够，**可以只交付 Phase 1-2 并如实报告 Phase 3 未做**——半成品的 tips 不如没有。

- [ ] `FeatureTip` 组件（基于 `GuidedDialog`）：TIP 徽标 / 标题内联键位 chip / 正文 / 「设置→快捷键」重绑入口 / 主按钮「试试看」+ 次按钮「知道了」；
- [ ] **键位 chip 必须读实时绑定**：`settings.shortcuts.bindings[actionId]` + `formatKeyCombo()`；**未绑定时隐藏 chip** 并改文案为「去设置绑定一个」——**绝不硬编码键位**（教错快捷键比不教更糟）；
- [ ] tip 注册表 + 首批 3-5 条内容（从**已存在**的功能里挑，逐条核实存在后再写；右栏用纯 CSS/内联 SVG 演示，**禁止截图**，遵守 `prefers-reduced-motion`）；
- [ ] 频率：每会话 ≤1 条、两条间隔 ≥3 天、连续 2 次「知道了」则频率减半、全局开关；
- [ ] ⚠️ docs/58 §2.1 提到的「Ctrl+Shift+J 跳转 worktree」**是尚不存在的功能**，不要把它写成 tip 内容。

## 4. 验收（按 docs/59 §5 与 docs/58 §4）

必须逐条实测，不要只跑单测就宣称通过：

1. 有更新时右下角出现卡片；「立即更新」真下载安装并重启；
2. **构造"有 agent 在跑"的场景，确认不弹**；回到空闲后才弹；
3. 「稍后」24h 内不再弹；「跳过此版本」永不再弹该版本，更高版本仍弹；
4. 关闭全局开关后完全不弹，StatusBar 入口仍在；
5. 下载失败给可读原因 + 重试 + 下载页兜底；
6. 更新卡片与功能提示不同时出现；
7. 暗/亮色、中英双语、`prefers-reduced-motion` 各验一遍。

常规检查：

```bash
npx tsc --noEmit
npx vitest run <你改动涉及的测试文件>      # 不要跑全量
cargo clippy --workspace -- -D warnings ; echo "EXIT=${PIPESTATUS[0]}"
cargo fmt --all -- --check
```

⚠️ **不要用 `| tail` 判断 clippy 成败**——tail 会掩码退出码，必须用 `PIPESTATUS` 或不加管道。（这个坑今天已经骗过一次人。）

## 5. 提交与交付

- 每个 Phase 独立 commit，前缀 `feat(notify):` / `feat(update):` / `feat(tips):`；
- 完成后在工作树根写 `WORKER-REPORT.md`（**不要 commit**），包含：
  1. 状态 IMPLEMENTED / PARTIAL / BLOCKED；
  2. 每个 Phase 的完成情况 + 关键文件:行号；
  3. **明确列出没做到或没验证的部分**——诚实比完整重要，leader 据此决定是否合并；
  4. 验证结果：跑了哪些命令、退出码、通过数；
  5. sonner position 冲突你怎么解的；
  6. 与并行线的冲突预判（你改了哪些公共文件）。

## 6. 工量参考

Phase 1 ~0.25d + Phase 2 ~0.5d + Phase 3 ~1d ≈ **1.75d**。Phase 1-2 是主线，Phase 3 可延后。
