// closedTabs 上限裁剪（docs/68 §2.3 T1-c）。
// push 点（closeTab / closePane）正随 0.12.0 批1 迁往 paneRemovalActions.ts，
// 本函数先独立成工具：reopenClosedTab 侧已接（惰性裁剪），push 点由 leader
// 在 B1-05 收口时接入（push 后调一次即得严格上限）。
import type { ClosedTabSnapshot } from "./panesStoreTypes";

/** 单次运行内可恢复的已关闭标签上限；超出的最旧快照被丢弃。 */
export const CLOSED_TABS_LIMIT = 20;

/**
 * 原地裁剪到上限，保留数组尾部（最近关闭的）。
 * 接受 Immer draft 或普通数组；返回同一引用便于链式使用。
 */
export function trimClosedTabs(
  list: ClosedTabSnapshot[],
  limit: number = CLOSED_TABS_LIMIT,
): ClosedTabSnapshot[] {
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
  return list;
}

/** closeTab / closePane 记入 closedTabs 的快照映射（两处共用，字段一字不差） */
export function toClosedTabSnapshot(t: {
  projectId: string;
  projectPath: string;
  title: string;
  resumeId?: string;
  workspaceName?: string;
  providerId?: string;
  modelId?: string;
  providerSelection?: ClosedTabSnapshot["providerSelection"];
  launchProfileId?: string;
  workspacePath?: string;
  workspaceSnapshotId?: string;
  launchClaude?: boolean;
  cliTool?: ClosedTabSnapshot["cliTool"];
  ssh?: ClosedTabSnapshot["ssh"];
  wsl?: ClosedTabSnapshot["wsl"];
  machineName?: string;
  pinned?: boolean;
  starred?: boolean;
  parentTabId?: string;
}): ClosedTabSnapshot {
  return {
    projectId: t.projectId,
    projectPath: t.projectPath,
    title: t.title,
    resumeId: t.resumeId,
    workspaceName: t.workspaceName,
    providerId: t.providerId,
    modelId: t.modelId,
    providerSelection: t.providerSelection,
    launchProfileId: t.launchProfileId,
    workspacePath: t.workspacePath,
    workspaceSnapshotId: t.workspaceSnapshotId,
    launchClaude: t.launchClaude,
    cliTool: t.cliTool,
    ssh: t.ssh,
    wsl: t.wsl,
    machineName: t.machineName,
    pinned: t.pinned,
    starred: t.starred,
    parentTabId: t.parentTabId,
  };
}

/**
 * 恢复「标签在布局里的身份」（批4）。
 *
 * pinned/starred 不是创建参数，`addTab` 不接它们——必须在标签建好之后补打，
 * 否则撤销出来的是「同一个会话，但不是原来那个标签」：置顶掉了、星标没了。
 */
export function restoreClosedTabIdentity(
  store: {
    findPaneById: (paneId: string) => { type: string; tabs?: Array<{ id: string }> } | null;
    togglePinTab: (paneId: string, tabId: string) => void;
    toggleStarTab: (tabId: string) => void;
  },
  paneId: string,
  snapshot: Pick<ClosedTabSnapshot, "pinned" | "starred">,
): void {
  if (!snapshot.pinned && !snapshot.starred) return;
  const pane = store.findPaneById(paneId);
  if (pane?.type !== "panel" || !pane.tabs?.length) return;
  const tabId = pane.tabs[pane.tabs.length - 1].id;
  if (snapshot.pinned) store.togglePinTab(paneId, tabId);
  if (snapshot.starred) store.toggleStarTab(tabId);
}

/**
 * 非终端快照的重开分流（批4）。命中并处理返回 true；terminal 快照返回 false
 * 由调用方走 addTab 富路径。
 */
export function reopenNonTerminalSnapshot(
  store: {
    openBrowser: (url: string, title?: string) => string | null;
    openEditor: (
      projectPath: string,
      filePath: string,
      title: string,
      layoutId?: string,
      options?: { forcePaneTab?: boolean },
    ) => string | null;
  },
  snap: ClosedTabSnapshot,
): boolean {
  if (snap.contentType === "browser" && snap.browserUrl) {
    store.openBrowser(snap.browserUrl, snap.title);
    return true;
  }
  if (snap.contentType === "editor" && snap.filePath) {
    store.openEditor(snap.projectPath, snap.filePath, snap.title, undefined, {
      forcePaneTab: true,
    });
    return true;
  }
  return false;
}
