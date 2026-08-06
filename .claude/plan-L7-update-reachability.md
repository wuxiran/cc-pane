# L7 · 更新提示可达性：闸门放行 + 静默失败可见

> 独立修复线。起因：用户报告「我们的更新提示还没有」，
> 排查后确认**功能是完整实现的**，没冒出来是两个运行时原因。
>
> 本 plan 由 leader 派发，worker 在独立 worktree 中执行。

## 排查结论（已确认，不要重新调查）

整条链路都在，且配置齐全：

| 环节 | 位置 |
|---|---|
| updater 配置 | `src-tauri/tauri.conf.json:81-85`（pubkey + endpoints 指向 GitHub `latest.json`），`:37 createUpdaterArtifacts: true`，`capabilities/default.json:28 updater:default` |
| 启动静默检查 | `web/hooks/useAppLifecycleLate.ts:60-62`，**无条件调用**（仅 `isTauriRuntime()` 判定） |
| 写入 store | `web/services/updaterService.ts:25-37` `checkUpdateSilent()` → `useUpdateStore.setUpdate()` |
| 卡片 | `web/components/update/UpdateNotification.tsx` |
| 其它消费者 | `StatusBar.tsx` / `HomeHeader.tsx` / `settings/AboutSection.tsx` 各有「有新版本」标记 |

**所以不要去实现更新功能，它已经有了。** 本 plan 只修两处让它真正可达。

---

## 任务 1 · 打扰闸门对更新提示放行 agentBusy

### 现状

`web/lib/interruptGate.ts:38-56` 的 `checkInterruptGate` 对**所有** kind 一视同仁，
其中 `:42-44` 是：任一会话 `isBusyStatus()` 或 `waitingInput` → 返回 `agentBusy`，不打扰。

CC-Panes 的典型使用场景是长时间挂着 agent 干活，**几乎总有 busy 会话**。
于是更新卡片一直等不到可以出现的时机——不是不显示，是永远在等。

### 已拍板的改法

**只对 `update` 放行 `agentBusy` 这一条，其余全部保留。**

放行后 update 仍然要被这些挡住：
- 启动 30s 内（`STARTUP_GRACE_MS`，`:31 :45`）
- 有对话框打开（`hasOpenDialog()`，`:71-87`）
- 迷你模式（`:47`）
- 全屏（`:48`）
- 已被同级或更高优先级打扰占用（`:49-54`）

**`tip` 的行为一个字都不能变**——tip 仍然要被 agentBusy 挡住。
docs/58 §「失败模式唯一」原话是「tip 系统失败只有一种方式：**烦人**」，
在 agent 忙的时候弹功能提示正是那种烦人。更新提示不同：它是用户要的信息，
且卡片在右下角不打断任何操作。

### 实现要求

- 按 **kind** 区分，不要加一个 `skipBusyCheck` 之类的布尔参数由调用方传——
  那样规则就散到调用方去了，下一个人不看闸门源码就不知道有这回事。
  规则应该留在 `interruptGate.ts` 里，一眼能看全。
- `INTERRUPT_PRIORITY`（`:32-35`）的 `tip: 0` / `update: 1` **不要动**，
  单槽互斥语义保持不变。
- 注意 `UpdateNotification.tsx:195` 与 `:200-204` 有
  `check({ ignoreOwnInterrupt: true }) === "agentBusy"` 的用法——
  那是**安装前**的忙碌确认（`busyAtConfirmation`，会额外警告用户「正在跑的会话会被中断」）。
  **这个必须保留**：放行的是「显示卡片」，不是「安装时不管会话死活」。
  改完确认这条路径仍能拿到 `agentBusy`。

### 契约文档

`docs/60-notify-ui-handoff.md` 记录了闸门契约（Phase 1，`:45-54`），
其中「任一会话忙碌禁止打扰」现在有了例外。**在 docs/60 补一句说明**，
写清哪个 kind 放行、为什么放行、tip 为何不放行。不要让代码和契约文档对不上。

---

## 任务 2 · 静默检查失败不能只进 console

### 现状

`web/services/updaterService.ts:34-36`：

```ts
} catch (error) {
  console.error("[updater] 静默检查更新失败:", error);
}
```

失败被完全吞掉：不进应用日志、不进任何用户可见通道、store 也不更新
（保持上一次的值或初始 false）。

**这可能才是用户看不到更新提示的真正原因**——本项目环境已知 GitHub 直连不稳
（记录在案：git 需挂 socks5h 代理、npm 走 npmmirror），
而 endpoint 正是 `https://github.com/wuxiran/cc-pane/releases/latest/download/latest.json`。
连不上时用户得到的信号是「这软件从来不更新」。

这也违反 CLAUDE.md 的「错误显式处理，不 swallow」。

### 实现要求

失败要**可发现**，但**不要弹窗打扰**——静默检查之所以叫静默，就是不该为它弹东西。
建议的分层（你可以给出更好的方案，但要说明理由）：

1. **必须**：写进应用日志（本仓库有日志设施，去找现有用法，不要新造）。
2. **建议**：在 store 里记一个「上次检查失败/失败原因/失败时间」的状态，
   让 设置 → 关于 页能显示「上次检查失败：<原因>」而不是一片空白。
   `AboutSection.tsx` 已经有更新相关 UI（`:29-30, :50-51`），是天然落点。
3. **不要**：toast、卡片、任何主动弹出。

另外核实一处：失败时 `useUpdateStore` 应该保持什么状态？
当前是什么都不做。考虑「上次检查到有更新、这次检查失败」的情形——
保留旧的 `available: true` 是合理的（更新确实还在），但要确认这不会造成
版本号陈旧的误导。给出你的判断。

### 顺带

`checkUpdateSilent` 用的是裸 `console.error`，而本仓库有 `handleErrorSilent` /
`handleError` 等统一错误处理工具（见 `web/utils`，`UpdateNotification.tsx` 里大量在用）。
统一过去。

---

## 验收

```
npx tsc --noEmit
npm run test:run
```

**禁止用 `| tail`**——本仓库明确记录管道会掩码退出码（取自 tail，永远成功），
把失败报成通过。判定看真实退出码。
vitest 若报 fork 超时类 Errors，用 `--maxWorkers=3` 重跑再判（已知高负载假失败）。

### 测试要求

`web/lib/interruptGate` 与 `web/components/update/UpdateNotification.test.tsx` 都有既有测试。

- **闸门**：`kind="update"` 在有 busy 会话时**返回 null（放行）**；
  `kind="tip"` 在同样条件下**仍返回 `agentBusy`**；
  `kind="update"` 在对话框打开 / 迷你模式 / 全屏 / 启动 30s 内**仍被挡**。
  最后这组是防止「放行过头」的关键，不要漏。
- **安装前确认**：`UpdateNotification` 的 `requestInstall` 在有 busy 会话时
  仍能拿到 `agentBusy` 并设置 `busyAtConfirmation`。
- **静默失败**：`check()` reject 时不抛出、有日志、store 状态符合你的设计。

### 自查

- [ ] tip 的行为完全没变（这是最容易误伤的地方）
- [ ] update 只放行了 agentBusy，其余四条都还挡着
- [ ] 安装前的忙碌警告仍在
- [ ] docs/60 的契约已补充说明
- [ ] 没有为静默检查失败弹任何东西
- [ ] 裸 `console.error` 已换成统一错误处理

## 边界

- 不要碰 `web/components/tips/`（另一个 worker 正在扩容 tips，同期改会冲突）
- 不要改 `INTERRUPT_PRIORITY` 的取值或单槽互斥语义
- 不要实现新的更新机制——现有的是完整的
- 不要改 `tauri.conf.json` 的 updater 配置
- 不要提交 git

## 收尾

按 docs/65 观测契约上报。必须包含：
闸门按 kind 区分的实现方式、失败可见性的分层设计与理由、
失败时 `useUpdateStore` 保持什么状态及判断依据、
两条命令的真实退出码、新增测试数、
以及你是否验证过 tip 行为未变（怎么验证的）。
