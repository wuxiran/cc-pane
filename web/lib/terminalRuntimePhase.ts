// 终端运行时阶段的判别联合（docs/78 批5，降级版）。
//
// # 问题
//
// 一个终端「现在处于什么状态」由 7 个互相独立的可选布尔/字符串字段描述：
// restoring / savedSessionId / restoreBlockedReason / leaseReadOnly /
// launchError / launchAttempt / disconnected。合法组合从未被声明过，每个消费方
// 各自脑补——「restoring 且有 launchError 是什么意思」这种问题没有答案，
// 于是同一种状态在不同地方判出不同结果。
//
// # 本文件做什么
//
// **纯派生**：把那 7 个字段折叠成一个互斥的阶段枚举。不动存储、不动双写、
// 零迁移——docs/78 原计划的「leaf 为单一真相 + 删 syncTabTerminalState」是
// 全项目最高风险的改动，按用户决定降级为只做这层判别联合，全量收敛留待
// 0.12.x 观察期后按「双写 bug 数」判据评估。
//
// 优先级顺序本身就是规格：先问「有没有死」，再问「能不能用」，最后才是
// 「在忙什么」。顺序写错会让用户看到「正在恢复」的死会话。

/** 终端运行时的互斥阶段。 */
export type TerminalRuntimePhase =
  /** 还没启动过（新建标签，尚未 spawn PTY） */
  | "idle"
  /** 正在创建 PTY */
  | "launching"
  /** 启动失败，等用户重试 */
  | "launch-failed"
  /** 正在恢复一个已存在的会话 */
  | "restoring"
  /** 想恢复但被挡住（别的实例正持有、路径不存在等） */
  | "restore-blocked"
  /** 正常运行 */
  | "running"
  /** 会话还在但连接断了（daemon 不可达 / 租约被别人抢走） */
  | "disconnected"
  /** 进程已退出 */
  | "exited";

/** 判定所需的输入。字段名与 Tab / TerminalPaneLeaf 上的一致。 */
export interface TerminalPhaseInput {
  sessionId?: string | null;
  savedSessionId?: string;
  restoring?: boolean;
  restoreBlockedReason?: string;
  leaseReadOnly?: boolean;
  launchError?: unknown;
  launchAttempt?: number;
  disconnected?: boolean;
  exitCode?: number;
}

/**
 * 折叠成单一阶段。
 *
 * 判定顺序不可随意调整——它编码了「哪个状态更要紧」：
 * 1. 退出码存在 = 已经死了，别的都不重要；
 * 2. 启动失败 = 用户需要看到错误并重试；
 * 3. 被挡住的恢复 = 需要用户处置（比「正在恢复」更要紧，否则会显示一个
 *    永远转圈的假恢复）；
 * 4. 恢复中 / 启动中；
 * 5. 断连（会话还在，只是连不上）；
 * 6. 有会话 = 运行中；
 * 7. 都没有 = 空闲。
 */
export function phaseOf(input: TerminalPhaseInput): TerminalRuntimePhase {
  if (input.exitCode !== undefined && input.exitCode !== null) return "exited";
  if (input.launchError) return "launch-failed";
  if (input.restoreBlockedReason) return "restore-blocked";
  if (input.restoring) return "restoring";
  // 有 savedSessionId 但还没 attach 上 = 恢复流程在途（restoring 标志可能
  // 还没来得及置位，两者不总是同步）
  if (input.savedSessionId && !input.sessionId) return "restoring";
  if (input.disconnected) return "disconnected";
  if (input.sessionId) return "running";
  if ((input.launchAttempt ?? 0) > 0) return "launch-failed";
  return "idle";
}

/** 这个阶段下终端是否可交互（能收键盘输入）。 */
export function isInteractivePhase(
  phase: TerminalRuntimePhase,
  leaseReadOnly?: boolean,
): boolean {
  if (leaseReadOnly) return false;
  return phase === "running";
}

/** 这个阶段下是否该显示加载态。 */
export function isPendingPhase(phase: TerminalRuntimePhase): boolean {
  return phase === "launching" || phase === "restoring";
}

/** 这个阶段下是否需要用户处置（错误态）。 */
export function needsUserActionPhase(phase: TerminalRuntimePhase): boolean {
  return phase === "launch-failed" || phase === "restore-blocked";
}

/** 这个阶段下会话是否还活着（决定关闭时要不要回收 PTY）。 */
export function isLivePhase(phase: TerminalRuntimePhase): boolean {
  return phase === "running" || phase === "disconnected" || phase === "restoring";
}
