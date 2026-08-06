# 只读评审 BRIEF：分支 01111-provider-ui-rework

**你是只读评审员。不要修改任何文件，不要跑测试，不要 git 操作。**
输出一份 findings 列表即可（每条：文件:行 / 问题 / 为什么是真问题 / 建议）。

## 上下文

CC-Panes（Tauri 2 + React 19 + TS + Zustand）的 Settings → Provider 两页 UI 重构，共 10 个 commit。
**范围约束**：纯 UI/视觉 + 文件组织。store、保存流程、managed/native 双模式语义一律不动。
所以「这里顺手改了业务语义」本身就是缺陷。

完整 diff：`.claude/review-provider-ui/branch.diff`（相对 main，仅 web/）。
源码在仓库里，可自由 Read/Grep 交叉核对。

门禁状态：`npx tsc --noEmit` = 0；`npm run test:run` 3379 例全过；`npm run build` = 0。
所以**不要报「加个测试就好」这类**，要报语义/正确性问题。

## 请重点攻击这三件事

### 1. 批6 拆文件：闭包提升是否等价
`LaunchProfilesPanel.tsx` 原 397-756 行的 draft 变换全部抽到
`web/components/providers/launchProfileSkillPolicy.ts`，改成纯函数 `(draft, ...deps) => draft`。

原代码是闭包，除了 `draft` 还捕获了外层的 `servers` 和 `externalSkills`；
现在这两个提升为**显式入参**，由调用点传入。请核对：
- 每个函数的入参是否等价于它原先捕获的那份数据（是否有传错、传成过滤后的子集、传成 stale 引用）；
- 调用点是否**全部**写成 `setDraft((cur) => nextXxx(cur, arg))` 更新器形式。
  若还有 `setDraft(nextXxx(draft, x))` 这种捕获写法，连续两次 toggle 会读到 stale draft 丢更新；
- `useSkillMarketData.ts` 抽出的市场安装流程：`installSkill(entry, onInstalled)`
  把「改 draft」留给回调，hook 本身不依赖 draft。核对回调触发时机与原实现是否一致。

同批还抽出 `LaunchProfileSummaryCard.tsx` / `LaunchProfileBasicsCard.tsx` 两个纯展示组件，
BasicsCard 里六处 `setDraft({...draft, …})` 被改写为更新器形式——核对字段没有漏项或错位。

### 2. 批8 两处原生 select → Radix Select：null 转换是否等价
- `ProviderTypeSelect.tsx`（新文件，从 `ProviderFormPanel.tsx` 抽出，删了 `ProviderTypeOptions.tsx`）
- `ProviderModelsEditor.tsx` 的「默认推理强度」

Radix 不接受空串 value，空值走 `SELECT_NONE = "__none__"` 哨兵再转回 `null`。
**`ProviderModelsEditor.tsx` 没有测试文件**，请特别仔细：
`value`/`onValueChange` 语义是否与原生 `<select value={x ?? ""} onChange={e => e.target.value || null}>` 完全等价？
有没有可能把 `"__none__"` 当成真实 effort 值存进 provider 的 models 数组？

### 3. 新增身份色 token 的暗色对比度
`web/assets/index.css` 新增 `--app-identity-provider-*` 亮暗两套，
`ProviderAvatar.tsx` 的 `PROVIDER_TYPE_COLORS` 从 12 个 hex 改成 `var()` 引用。
头像是**底色 + 白字**。暗色下只有两个改了值：
- `cursor` #111827 → #4B5563
- `config_profile` #6B7280 → #8892A4

请核对：①其余 10 个在暗色底（`--app-content: #1E2024`）上是否可辨认；
②白字压在这些底色上对比度是否够（大号粗体按 3:1 判）；
③是否有该复用已有 token 却重复定义、或反过来错误复用了前景色 token（`--app-cli-*` 是前景色，
暗色下被整体提亮，故**刻意没有复用**——核对这个判断成立吗）。

## 其他可报的

- 批7 新增的跨分组搜索：`LaunchProfileSkillCard.tsx` / `LaunchProfileMcpCard.tsx`
  查询只裁剪可见行、分组计数仍按全量（刻意如此，避免计数随输入跳变）。核对是否有分组在搜索时
  该隐藏没隐藏 / 该显示没显示，或空态分支互相遮挡。
- `CollapsibleCheckGroup.tsx` 新增 `forceOpen`。已知问题（**不用再报**）：
  该组件 `useState(defaultOpen ?? !collapsible)` 只在 mount 取值，异步加载的分组在首帧
  `total=0` → 不可折叠 → 开着，数据到位后不会自动收起。这是既有行为，本次未改，已另行记录。
- 5 处内联 `var(--app-content)` → `var(--app-panel-bg)`：核对这些元素语义上确实是
  「浮在内容区之上的卡壳/骨架」，而非内容区本身底色。
