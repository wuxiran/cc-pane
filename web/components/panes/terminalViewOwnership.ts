// 同一个会话可以挂多个视图：主窗格里的那个（主视图），以及星标镜像、弹出窗口这类副视图。
// 它们各有一个 xterm，各自回放、各自订阅，进度并不一致；但 seq 账本
// （terminalOutputSeqTracker.ts）和 checkpoint 是按会话共享的。
//
// 规则：共享的东西只归主视图。
// - seq 账本只由主视图推进/重锚/判失效。副视图写完一块不代表主视图写完了——让它推进
//   written，主视图就会带着还没落屏的尾巴拍照；让它重锚，账本会倒回它那份快照的位置，
//   而主视图的屏幕其实已经走到更后面。
// - checkpoint 只由主视图上传。副视图的画面可能缺行（它回放期间的输出发给了主视图，
//   自己没收到），存成正式快照后，后端会裁掉锚点之前的原始输出，以后恢复也补不回来。
//
// 每个视图自己的恢复进度（最近一次快照覆盖到哪）按 xterm 实例单独记，不进共享账本。

const secondaryViews = new WeakSet<object>();

/** 副视图（镜像 / 只读弹窗）建好 xterm 后登记。没登记的一律按主视图处理。 */
export function markSecondaryTerminalView(term: object): void {
  secondaryViews.add(term);
}

export function isSecondaryTerminalView(term: object | null | undefined): boolean {
  return term != null && secondaryViews.has(term);
}

/**
 * 本视图最近一次快照恢复覆盖到的 endSeq。绑定输出回调时取走，给对账器设下限
 * （terminalSnapshotOverlap.ts）。取一次即清；只在短时间内有效——daemon / PTY 重建后
 * seq 从头计，陈旧的下限会把新流的开头误判成「已包含」。
 */
const RECOVERY_FLOOR_TTL_MS = 10_000;
const recoveryFloors = new WeakMap<object, { endSeq: number; at: number }>();

export function recordRecoveryFloor(term: object, endSeq: number, now: number = Date.now()): void {
  recoveryFloors.set(term, { endSeq, at: now });
}

export function takeRecoveryFloor(term: object | null | undefined, now: number = Date.now()): number | null {
  if (term == null) return null;
  const floor = recoveryFloors.get(term);
  if (!floor) return null;
  recoveryFloors.delete(term);
  return now - floor.at <= RECOVERY_FLOOR_TTL_MS ? floor.endSeq : null;
}
