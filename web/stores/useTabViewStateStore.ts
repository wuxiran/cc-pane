// 可见性单一事实源（docs/78）。
//
// 此前「可见」至少有 6 种口径各说各话：Panel 三 props、TerminalView 三 ref、
// isRenderVisible()、shouldRunWebglRecovery()、BrowserTabContent 自造一套、
// layoutScheduler 自带 isActive + 8 处 allowInactive 逃生阀。没有权威来源的
// 直接后果：星标页正看着，原 tab 照样休眠；弹窗与 SelfChat 永远自认可见，
// 降档/休眠完全不生效。
//
// **可见性属于「视图」，不属于「标签」**：同一个 PTY 可能同时被主标签、星标
// 镜像、弹出窗口三个视图观看；而 SelfChat 跑着真实 Claude 会话却根本没有
// tabId（它是全屏主视图，不在 pane 树里）。所以键是 owner:role，owner 是
// 「PTY 归属方」——标签用 tabId，SelfChat 用自己的会话标识。
//
// 独立轻 store：可见性是高频写入，混进 usePanesStore 会让每次切标签都触发
// 布局树的全部订阅者重算。
import { create } from "zustand";

export type ViewRole = "primary" | "mirror" | "popup" | "selfchat";

/**
 * 三档而非布尔：
 * - active：可见且持有焦点（焦点 pane 的当前标签）
 * - visible：可见但无焦点（分屏里的非焦点格、星标镜像）
 * - hidden：不可见（后台标签、非当前布局、最小化的弹窗）
 *
 * 渲染/WebGL 恢复看单视图的 active；降档/休眠看聚合的 anyVisible。
 */
export type ViewVisibility = "active" | "visible" | "hidden";

/** PTY 归属方。标签是 tabId；SelfChat 无 tab，自身即一个聚合单元。 */
export type ViewOwnerId = string;

export type ViewKey = `${ViewOwnerId}:${ViewRole}`;

export interface TabViewEntry {
  owner: ViewOwnerId;
  role: ViewRole;
  visibility: ViewVisibility;
}

export interface ViewAggregate {
  /** 任一视图可见（active 或 visible）。**降档/休眠的唯一判据**。 */
  anyVisible: boolean;
  /** 任一视图持有焦点。 */
  anyActive: boolean;
  /**
   * 最后一次「有视图可见」的时间戳；从未可见过为 null。
   * 休眠时长判据用它，所以 remove-再-report 不能重置它（见 recomputeAggregate）。
   */
  foregroundLastSeenAt: number | null;
  /**
   * 上一次 anyVisible 的**用户语义**值，与视图是否在场无关。
   *
   * 为什么不能直接看 anyVisible：removeView 会把它置 false，于是 dev 双挂载的
   * cleanup→mount 在下一次 report 时被误判成「隐藏→可见」的真边沿，
   * foregroundLastSeenAt 被刷新，休眠时长在 dev 与 prod 算出不同结果。
   * 这个字段只在真正有视图上报 hidden 时才翻 false。
   */
  lastReportedVisible: boolean;
}

export interface TabViewState {
  views: Record<ViewKey, TabViewEntry>;
  aggregate: Record<ViewOwnerId, ViewAggregate>;

  reportView: (owner: ViewOwnerId, role: ViewRole, visibility: ViewVisibility) => void;
  removeView: (owner: ViewOwnerId, role: ViewRole) => void;
  /** 移除该 owner 的全部视图（销毁出口经 destroyPipeline.sweepOwnerState 调）。 */
  removeOwner: (owner: ViewOwnerId) => void;

  getAggregate: (owner: ViewOwnerId) => ViewAggregate | undefined;
  getViewVisibility: (owner: ViewOwnerId, role: ViewRole) => ViewVisibility | undefined;
}

export function viewKey(owner: ViewOwnerId, role: ViewRole): ViewKey {
  return `${owner}:${role}`;
}

/** SelfChat 的 owner 标识（它是全屏主视图，不在 pane 树里、没有 tabId）。 */
export function selfChatOwnerId(sessionId: string): ViewOwnerId {
  return `selfchat:${sessionId}`;
}

const EMPTY_AGGREGATE: ViewAggregate = {
  anyVisible: false,
  anyActive: false,
  foregroundLastSeenAt: null,
  lastReportedVisible: false,
};

/**
 * 按该 owner 的全部视图重算聚合。
 *
 * 写入时维护而非 selector 派生：selector 每次返回新对象会让
 * useSyncExternalStore 的快照永不相等（CLAUDE.md 记过这个崩页坑）。
 *
 * `foregroundLastSeenAt` **只在「不可见 → 可见」的边沿推进**，且 previous
 * 为 null 时才取当前时间——React19 dev 双挂载会 remove 再 report，若无条件
 * 刷新时间戳，休眠时长在 dev 与 prod 会算出不同结果。
 */
function recomputeAggregate(
  views: Record<ViewKey, TabViewEntry>,
  owner: ViewOwnerId,
  previous: ViewAggregate | undefined,
  now: number,
): ViewAggregate | null {
  let anyVisible = false;
  let anyActive = false;
  let hasAnyView = false;

  for (const entry of Object.values(views)) {
    if (entry.owner !== owner) continue;
    hasAnyView = true;
    if (entry.visibility === "hidden") continue;
    anyVisible = true;
    if (entry.visibility === "active") anyActive = true;
  }

  if (!hasAnyView) return null;

  // 边沿判据用 lastReportedVisible 而非 previous.anyVisible：后者会被
  // removeView 置 false，导致 dev 双挂载的 cleanup→mount 被误判成真边沿。
  const wasVisible = previous?.lastReportedVisible ?? false;
  const foregroundLastSeenAt = anyVisible && !wasVisible
    ? now
    : previous?.foregroundLastSeenAt ?? (anyVisible ? now : null);

  return {
    anyVisible,
    anyActive,
    foregroundLastSeenAt,
    lastReportedVisible: anyVisible,
  };
}

export const useTabViewStateStore = create<TabViewState>((set, get) => ({
  views: {},
  aggregate: {},

  reportView: (owner, role, visibility) => {
    const key = viewKey(owner, role);
    const current = get().views[key];
    // 写前 diff：同值不触发，否则每帧 render 都会唤醒全部订阅者。
    if (current && current.visibility === visibility) return;

    set((state) => {
      const views: Record<ViewKey, TabViewEntry> = {
        ...state.views,
        [key]: { owner, role, visibility },
      };
      const next = recomputeAggregate(views, owner, state.aggregate[owner], Date.now());
      return {
        views,
        aggregate: next
          ? { ...state.aggregate, [owner]: next }
          : state.aggregate,
      };
    });
  },

  removeView: (owner, role) => {
    const key = viewKey(owner, role);
    // 幂等：不存在则不写（React19 dev 双挂载会 cleanup 两次）。
    if (!get().views[key]) return;

    set((state) => {
      const views = { ...state.views };
      delete views[key];
      const next = recomputeAggregate(views, owner, state.aggregate[owner], Date.now());
      if (next) {
        return { views, aggregate: { ...state.aggregate, [owner]: next } };
      }
      // 最后一个视图没了：**保留聚合条目**（置为不可见）而不是删掉。
      // React19 dev 双挂载走 cleanup → mount，删掉的话 foregroundLastSeenAt
      // 会丢失，重新 report 时只能取当前时间，休眠时长在 dev 与 prod 算出
      // 不同结果。真正的清理归 removeOwner（tab 销毁时由统一出口调）。
      const previous = state.aggregate[owner];
      return {
        views,
        aggregate: {
          ...state.aggregate,
          [owner]: {
            anyVisible: false,
            anyActive: false,
            foregroundLastSeenAt: previous?.foregroundLastSeenAt ?? null,
            // 视图不在场 ≠ 用户切走了：保留语义值，见字段注释。
            lastReportedVisible: previous?.lastReportedVisible ?? false,
          },
        },
      };
    });
  },

  removeOwner: (owner) => {
    const state = get();
    const keys = Object.keys(state.views).filter(
      (k) => state.views[k as ViewKey]?.owner === owner,
    );
    if (keys.length === 0 && !state.aggregate[owner]) return;

    set((prev) => {
      const views = { ...prev.views };
      for (const k of keys) delete views[k as ViewKey];
      const aggregate = { ...prev.aggregate };
      delete aggregate[owner];
      return { views, aggregate };
    });
  },

  getAggregate: (owner) => get().aggregate[owner],
  getViewVisibility: (owner, role) => get().views[viewKey(owner, role)]?.visibility,
}));

/** 无视图时的安全默认：当作不可见（宁可降档，不可把已死视图当活的）。 */
export function aggregateOf(owner: ViewOwnerId): ViewAggregate {
  return useTabViewStateStore.getState().aggregate[owner] ?? EMPTY_AGGREGATE;
}
