# 反馈通道治理：toast / 通知中心 / Banner / inline 使用矩阵

> 本文约定 CC-Panes 四类用户反馈通道的判定标准与落地方式。新代码按本矩阵选择通道；
> 业务代码不裸调 `toast()`，统一走 `web/lib/feedback.ts` 的薄封装。

## 通道一览

| 通道 | 组件/入口 | 位置 | 生命周期 | 是否可回看 |
|------|-----------|------|----------|------------|
| Toast（瞬时提示） | sonner `<Toaster>`，业务经 `web/lib/feedback.ts` | 底部居中（`bottom-center`，offset 避开 StatusBar） | 自动消失（3–6s） | 否 |
| 通知中心（异步事件） | `web/components/notifications/NotificationCenter.tsx` + `useNotificationStore` | 右下角卡片栈 + 历史面板 | 卡片自动消失（error/askInput 常驻），历史保留 | 是 |
| Banner（阻断性告警） | `web/components/layout/AlertBannerShell.tsx`（OrchestratorAlertBanner、RestoreRegressionBanner 已收敛于此） | 主区顶部通栏 | 条件存续期间常驻，需用户处置或状态解除才消失 | 是（存续期间） |
| Inline（表单/字段错误） | 各表单组件就地渲染 | 出错字段旁 | 随输入修正即时消除 | 是（存续期间） |

## 判定标准

按以下顺序自上而下判定，命中即停：

1. **是否阻断当前流程、或属于会话/应用级告警？**
   是 → **Banner**。特征：用户不处理就无法（或不应）继续；与具体某个输入框无关。
   例：编排器异常、恢复回归告警、许可证/只读模式。
2. **是否属于表单提交或字段级校验失败？**
   是 → **Inline**。错误必须定位到具体字段，随输入修正即时消除；不要用 toast 报表单错误。
3. **是否需要可回看、可操作（回复/跳转/重试）的异步事件？**
   是 → **通知中心**。特征：事件由后台/CLI/远端异步产生，用户可能当时不在看；或需要用户在事件上采取行动。
   例：终端任务完成/失败、waiting_input、AI 主动通知、更新可用。
4. **其余瞬时操作确认** → **Toast**。特征：由用户刚刚的动作直接触发、无需回看、看完即忘。
   例：`toastOk`（保存成功、已复制）、`toastInfo`（一般提示）、`toastErr`（同步操作失败）。

### 反例速查

- 表单校验失败弹 toast → 错，应 inline。
- 后台任务完成只弹 toast → 错，用户切走就丢了，应进通知中心。
- 字段错误弹 Banner → 错，Banner 只用于会话/应用级阻断。

## 什么不该弹 toast

以下场景**不要**发 toast（已有的按「保守修复」原则逐步清理）：

- **同步、无风险、结果已在界面上可见的操作成功**：列表刷新完成、目录加载完成、界面已切换过去的选择操作——界面本身就是反馈。
  例（已清理）：SSH 远程文件创建/重命名后的「操作已完成」、远程 cd 后的「终端已切换到 …」。
- **纯加载/轮询完成**：静默更新 state 即可，除非加载结果需要用户立即决策。
- **高频事件**：拖拽过程、光标移动、逐字 streaming——toast 会连发刷屏；确实需要的用冷却/去重表（参考 `terminalSessionNotices.ts`）。
- **同一事件多处重复提示**：一个事件只在一个通道提示一次；toast + 通知中心同时报同一件事属于重复（ccchan 事件的气泡 + toast 并存已记录待收敛）。
- **错误但没有信息量**：`toastErr("出错了")` 不如不弹；错误 toast 必须带可行动的上下文（什么操作失败 + 原因/下一步）。

可以保留的 toast：「已复制」类（剪贴板无界面反馈）、手动触发的同步操作结果（保存、删除、导入、模板应用等带对象名的确认）。

## 落地方式

### Toast：统一封装 `web/lib/feedback.ts`

```ts
import { toastOk, toastErr, toastInfo, toastWarn } from "@/lib/feedback";

toastOk(t("fileSaved", { ns: "editor" }));
toastErr(t("popOutFailed", { ns: "panes", error: String(err) }));
```

- 封装内部统一 `duration`（ok 3s / info 4s / warn 5s / err 6s），`richColors` 由 `<Toaster>` 声明。
- 需要记录日志 + 翻译后端错误时仍走 `handleError`（`web/utils/errorHandler.ts`），它与 feedback 封装并存：`handleError` 管「失败 + 日志」，feedback 管「语义 + 时长」。
- 新代码不裸调 `toast()` / `toast.success()`。

### Toaster 挂载与位置

- 主窗口：`web/components/layout/AppShell.tsx`，`position="bottom-center"`，`offset={TOASTER_OFFSET_MAIN}`。
  理由：右下是通知中心卡片栈（`fixed bottom-11 right-3`），顶部有 TitleBar 与 Banner，底部有 28px StatusBar；
  底部居中 + 40px offset（28px StatusBar + 12px 间距）三者都不遮挡。
- ccchan 浮窗：`web/ccchan/CCChanApp.tsx`，同样 `bottom-center`，`offset={TOASTER_OFFSET_CCCHAN}`（浮窗无 StatusBar）。
- 位置与 offset 常量由 `web/lib/feedback.ts` 导出（`TOASTER_POSITION` / `TOASTER_OFFSET_MAIN` / `TOASTER_OFFSET_CCCHAN`），不写裸 CSS hack。

### 通知中心

异步事件经 `notifyAsync(...)`（`web/lib/feedback.ts`）或直接 `useNotificationStore.add + showToast`；
分类与自动消失策略见 `web/lib/notificationTaxonomy.ts`。

### Banner

新 Banner 一律挂到 `web/components/layout/AlertBannerShell.tsx` 的既有收敛点，不再新增独立通栏组件。

### Inline

表单错误在字段旁就地渲染（各 settings/dialog 表单既有模式），提交级错误可辅以 `toastErr`。

## i18n

所有面向用户的反馈字符串必须走 i18n（`zh-CN` + `en` 同步加 key），禁止在 toast/通知里写死中英文串。
