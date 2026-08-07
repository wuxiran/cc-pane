// closedTabs 撤销栈的工具集（docs/68 §2.3 T1-c）：上限裁剪、快照映射、
// 身份恢复、非终端重开分流。push 点在 removeTabsInternal（push 后裁剪，
// 严格上限 20），reopenClosedTab 侧另有惰性裁剪兜底。
import { current, isDraft } from "immer";

import { TAB_LIFECYCLE } from "@/lib/tabLifecycle/registry";

import {
  resetTerminalTreeForRelaunch,
  stripInitialPrompt,
} from "@/lib/tabLifecycle/terminalLeafReset";
import type { LaunchExtras, TerminalPaneNode } from "@/types";
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
  launchExtras?: LaunchExtras;
  terminalRootPane?: TerminalPaneNode;
}): ClosedTabSnapshot {
  return {
    projectId: t.projectId,
    projectPath: t.projectPath,
    title: t.title,
    resumeId: t.resumeId,
    workspaceName: t.workspaceName,
    providerId: t.providerId,
    modelId: t.modelId,
    providerSelection: detach(t.providerSelection),
    launchProfileId: t.launchProfileId,
    workspacePath: t.workspacePath,
    workspaceSnapshotId: t.workspaceSnapshotId,
    launchClaude: t.launchClaude,
    cliTool: t.cliTool,
    ssh: detach(t.ssh),
    wsl: detach(t.wsl),
    machineName: t.machineName,
    pinned: t.pinned,
    starred: t.starred,
    parentTabId: t.parentTabId,
    launchExtras: stripInitialPrompt(detach(t.launchExtras)),
    terminalRootPane: snapshotTerminalTree(t.terminalRootPane),
  };
}

/**
 * 脱 draft（CLAUDE.md「从 Immer draft 里带出数据必须深拷贝」）。
 *
 * 快照活得比 `set()` 长：直接留住 draft 里的嵌套对象（ssh / wsl /
 * providerSelection / launchExtras / 整棵终端树），撤销时读到的是**已被 revoke
 * 的 proxy**，抛 `Cannot perform 'get' on a proxy that has been revoked`。
 * 这条只在撤销那一刻触发，写快照时一切正常——所以标量字段不必过，嵌套对象
 * 一个都不能漏。
 */
function detach<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return structuredClone(isDraft(value) ? (current(value) as T) : value);
}

/**
 * 分屏结构进快照（docs/78 批4）。
 *
 * 三条约束：
 * 1. **单格不存**——addTab 会自然建出一个 leaf，存了反而多一层无意义的回放；
 * 2. 先脱 draft 再重置（见 detach）；
 * 3. 存的是**已重置**的树：撤销恢复布局与启动身份，不恢复死掉的 PTY。
 */
function snapshotTerminalTree(
  root: TerminalPaneNode | undefined,
): TerminalPaneNode | undefined {
  if (!root || root.type !== "split") return undefined;
  return resetTerminalTreeForRelaunch(detach(root));
}

/**
 * 恢复「标签在布局里的身份」（docs/78）。
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
 * 恢复分屏结构（docs/78 批4）。addTab 只会建出单格；多格 tab 撤销后若不回放
 * 这棵树，用户拿回的是「同一个项目的一个新标签」，而不是原来那个四格工作台。
 *
 * 在 pane 的最后一个 tab 上写（addTab 恒 push 到末尾，与 restoreClosedTabIdentity
 * 同一取法）。回放时再过一次重置清单：同一条快照可被重开多次，直接复用会让
 * 两个 tab 拥有相同的 leaf id。
 */
export function restoreClosedTabSplitTree(
  applyTree: (tabId: string, root: TerminalPaneNode, activeLeafId: string) => void,
  findPaneById: (paneId: string) => { type: string; tabs?: Array<{ id: string }> } | null,
  paneId: string,
  snapshot: Pick<ClosedTabSnapshot, "terminalRootPane">,
): void {
  const root = snapshot.terminalRootPane;
  if (!root || root.type !== "split") return;
  const pane = findPaneById(paneId);
  if (pane?.type !== "panel" || !pane.tabs?.length) return;
  const tabId = pane.tabs[pane.tabs.length - 1].id;
  const restored = resetTerminalTreeForRelaunch(root);
  applyTree(tabId, restored, firstLeafId(restored));
}

function firstLeafId(node: TerminalPaneNode): string {
  return node.type === "leaf" ? node.id : firstLeafId(node.children[0]);
}

/**
 * 非终端快照的重开分流（docs/78）。命中并处理返回 true；terminal 快照返回 false
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
    /** 按 filePath 找刚建出的 editor 标签（openEditor 只返回 layoutId）。 */
    findEditorTabIdByPath?: (filePath: string) => string | null;
  },
  snap: ClosedTabSnapshot,
): boolean {
  if (snap.contentType === "browser" && snap.browserUrl) {
    store.openBrowser(snap.browserUrl, snap.title);
    return true;
  }
  if (snap.contentType === "editor" && snap.filePath) {
    const layoutId = store.openEditor(snap.projectPath, snap.filePath, snap.title, undefined, {
      forcePaneTab: true,
    });
    // onRestoreState（docs/78 批4）：把光标还给新标签。
    //
    // **openEditor 返回的是 layoutId，不是 tabId**——直接拿它当标签 id 用，
    // 视图状态会记在一个不存在的标签名下，光标恢复静默失效（docs/69 同型）。
    // Files 视图下它还会返回 null（不建 pane tab，CLAUDE.md 明列）。
    // 所以新标签 id 要按 filePath 去树里找。
    if (layoutId) {
      const newTabId = store.findEditorTabIdByPath?.(snap.filePath);
      if (newTabId) {
        TAB_LIFECYCLE.editor.onRestoreState?.(newTabId, {
          contentType: "editor",
          projectId: snap.projectId,
          projectPath: snap.projectPath,
          title: snap.title,
          filePath: snap.filePath,
          viewState: snap.viewState,
        });
      }
    }
    return true;
  }
  return false;
}
