// 可见性双写漂移断言（docs/78）。
//
// 迁移期两条路并存：旧的三 props/ref 与新的 useTabViewStateStore。这个模块在
// dev 下比对两者，不一致就打日志——**不抛错**，因为可见性判断错了顶多是多降
// 一次档，而抛错会让终端整个白屏，代价远大于问题本身。
//
// 为什么不能粗暴比一个布尔：两条路的语义粒度不同。
// 旧 ref 是「本视图可见」，store 聚合是「任一视图可见」——同一个 PTY 被星标
// 页镜像着时，两者本来就该不同。所以按投影分别比：
//   - 单视图可见性 ↔ 本视图的 role 条目
//   - 聚合 anyVisible ↔ 只在「本视图是唯一视图」时才与旧 ref 可比
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import type { ViewRole, ViewVisibility } from "@/stores/useTabViewStateStore";

export interface VisibilitySnapshot {
  /** 旧路：本视图的三 ref 派生值 */
  legacyRenderVisible: boolean;
  legacyActive: boolean;
  /** 新路：store 里本视图的档位 */
  storeVisibility: ViewVisibility | undefined;
  /** 新路：该 owner 的聚合 */
  storeAnyVisible: boolean;
  /** 该 owner 当前登记了几路视图（>1 时聚合与单视图本就可能不同） */
  storeViewCount: number;
}

export interface DriftReport {
  kind: "single-view" | "active";
  legacy: boolean;
  store: boolean;
}

/**
 * 比对两条路，返回漂移项（空数组 = 一致）。
 *
 * 三条豁免，都是「本来就该不同」而非漂移：
 * 1. store 里还没有本视图条目 —— 上报 effect 尚未跑（首帧）或已退场（卸载中）。
 *    React19 dev 双挂载的 cleanup→mount 窗口正落在这里，报了就是噪声。
 * 2. 多路视图 —— 聚合含别的视图，与单视图 ref 不可比。
 * 3. 无 owner —— 只读镜像等不参与聚合的视图。
 */
export function detectVisibilityDrift(snap: VisibilitySnapshot): DriftReport[] {
  if (snap.storeVisibility === undefined) return [];

  const drifts: DriftReport[] = [];

  const storeSingleVisible = snap.storeVisibility !== "hidden";
  if (storeSingleVisible !== snap.legacyRenderVisible) {
    drifts.push({
      kind: "single-view",
      legacy: snap.legacyRenderVisible,
      store: storeSingleVisible,
    });
  }

  const storeActive = snap.storeVisibility === "active";
  if (storeActive !== snap.legacyActive) {
    drifts.push({ kind: "active", legacy: snap.legacyActive, store: storeActive });
  }

  return drifts;
}

let warnedKeys = new Set<string>();

/** 测试用：重置去重记忆。 */
export function resetVisibilityDriftWarnings(): void {
  warnedKeys = new Set();
}

/**
 * dev 下报告漂移。同一 (owner, role, kind) 只报一次——每帧 effect 会高频调用，
 * 不去重的话一次漂移能刷满控制台，反而盖住别的日志。
 */
export function reportVisibilityDrift(
  owner: string,
  role: ViewRole,
  snap: VisibilitySnapshot,
): void {
  if (!import.meta.env.DEV) return;
  for (const drift of detectVisibilityDrift(snap)) {
    const key = `${owner}:${role}:${drift.kind}`;
    if (warnedKeys.has(key)) continue;
    warnedKeys.add(key);
    console.warn("[visibility-drift]", {
      owner,
      role,
      kind: drift.kind,
      legacy: drift.legacy,
      store: drift.store,
      viewCount: snap.storeViewCount,
    });
  }
}

/**
 * 组件侧便捷入口：自己去 store 取新路的值再比对。
 * 抽出来是为了让 TerminalView 的每帧 effect 只留一行（它已触到行数棘轮）。
 */
export function checkVisibilityDrift(
  owner: string | undefined,
  role: ViewRole | undefined,
  legacyRenderVisible: boolean,
  legacyActive: boolean,
): void {
  if (!import.meta.env.DEV || !owner) return;
  const resolvedRole = role ?? "primary";
  const state = useTabViewStateStore.getState();
  reportVisibilityDrift(owner, resolvedRole, {
    legacyRenderVisible,
    legacyActive,
    storeVisibility: state.getViewVisibility(owner, resolvedRole),
    storeAnyVisible: state.aggregate[owner]?.anyVisible ?? false,
    storeViewCount: Object.values(state.views).filter((v) => v.owner === owner).length,
  });
}
