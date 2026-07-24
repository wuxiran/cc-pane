# 48 — 会话/终端生命周期批(0.11.0 收尾批,Worker H 执行依据)

> 三个条目同批:#12 kill 关标签的回归测试与兜底、#11 对账 completed 判定复核、#13 终端 fit 修复 + 右键手动 fit。统一原则(E2 已确立):**只有 WS exit/killed 或会话从 map 移除才算进程退出,hook 上报的 Exited 只是 CLI 生命周期状态**。

## 1. kill 关标签:回归测试 + 控制通道兜底(#12)

主修复已在 main(`159427f` 的 `poll_status_from_session_presence`,桥接不再因 hook-Exited 拆除)。本批补:

- **回归测试**(`terminal_daemon_event_bridge.rs` 测试区,现有 drain 用例旁):模拟"会话 hook 状态 Exited 但 daemon 仍返回该会话 → 桥接保持存活 → 随后 kill 发 `session-killed`" → 断言桥接在 kill 前未拆除、killed 帧被消费并触发前端事件路径。
- **控制通道兜底**:daemon 侧 `kill_with_reason`(server.rs:617-631 一线)若目标会话**无 WS 订阅者**(桥接因任何原因暂缺),经 control WS(server.rs:655-703)广播一条会话级 killed,桌面侧 control 消费处转发同样的 `SESSION_KILLED` app emit(幂等:与桥接路径重复到达时前端 `closeTabBySessionId` 天然幂等)。
- 已识别旁支(docs/38 遗留,顺手做):`usePanesStore.ts:2820-2833` pinned tab 对 backend-driven kill 的静默不关——kill(mcp/backend reason)应无视 pinned 关闭,或至少 toast 告知;starred 布局路径已覆盖勿回归。

## 2. 对账 completed 判定复核(#11)

现象:worker 会话启动 ~10s 消失,TaskBinding 被对账标 completed/100%/exitCode 0,无 completionSummary("退出"≠"完成")。

- 找到对账写 completed 的位置(前端 `useOrphanSessionReconciler.ts` 与/或后端 reconcile;实施时查实),修正判定:
  - 会话消失/退出时,若 binding **已有** worker 主动写入的 completed(有 completionSummary)→ 保留;
  - 否则标 `failed`(或新增 `exited` 语义),exitCode 如实记录,不伪造 100% progress;
  - 判定输入源遵守统一原则:hook Exited 不作为"完成"证据。
- 测试:秒退无 summary → failed;正常收尾(先 update_task_binding completed 再退出)→ 保留 completed。

## 3. 终端 fit:拖动自适应修复 + 右键手动 fit(#13)

现象:拖动 Allotment 分隔条后部分终端不重排(内容溢出/截断)。

- **根因排查方向**(实施时查实):fit 触发是否只覆盖激活/可见终端;keep-alive `display:none` 视图与非激活子标签在容器 resize 时拿零尺寸被跳过;Allotment onChange → 各 TerminalView 的 fit 派发链;ResizeObserver 是否挂在正确元素。
- **修复**:分隔条拖动(含拖动结束)后,对受影响 pane 内**所有**终端(含非激活子标签)派发 fit;不可见(display:none / 零尺寸)的终端延迟到可见时补 fit(标脏位);fit → PTY resize 按会话防抖去重;**遵守 terminal-renderer-policy:共享 PTY 的镜像视图/移动端不默认 resize**(仅主视图驱动 PTY 尺寸)。
- **右键菜单**:终端上下文菜单新增「适应大小」(fit 当前终端 + PTY resize)与「全部终端适应大小」(遍历当前布局所有终端);i18n 中英(panes 命名空间);co-located 测试。
- 测试:模拟容器尺寸变化断言非激活 tab 也收到 fit;零尺寸延迟补 fit;菜单动作调用链;镜像视图不触发 PTY resize。

## 验证

- `cargo test -p cc-panes`(bridge/daemon)、前端 vitest 相关文件 + tsc。
- 手工(随 0.11.0 验证清单):批量 kill 多个 idle 会话 → 标签全关;秒退会话 binding 显示 failed;拖动分隔条各终端全部重排;右键 fit 生效。
