// 布局生命周期纯函数：默认/星标布局构造、持久化载入的清洗与压平、投影。
// 从 usePanesStore.ts 拆出（纯代码移动，逻辑不变）。
import { collectPanels, createPanel, findPane, generateId, syncTabTerminalState } from "@/lib/paneTree";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { inferCliTool, resolveRestoreMode } from "@/lib/terminalRestoreMode";
import { stripInitialPrompt } from "@/lib/tabLifecycle/terminalLeafReset";
import type { LayoutEntry, PaneNode, TerminalPaneNode } from "@/types";
import { firstNormalLayout, isNormalLayout, isStarredLayout } from "../paneLayoutHelpers";
import { filterLayouts, findLayout } from "./layoutTraversal";
import type { PanesDraft, PanesState } from "../panesStoreTypes";

export const STARRED_LAYOUT_NAME = "星标";

export function createDefaultLayout(name = "布局 1"): LayoutEntry {
  const rootPane = createPanel();
  return {
    id: generateId("layout"),
    name,
    kind: "normal",
    rootPane,
    activePaneId: rootPane.id,
  };
}

export function createStarredLayout(): LayoutEntry {
  const rootPane = createPanel();
  return {
    id: generateId("layout"),
    name: STARRED_LAYOUT_NAME,
    kind: "starred",
    rootPane,
    activePaneId: rootPane.id,
  };
}

export function ensureStarredLayout(layouts: LayoutEntry[]): LayoutEntry[] {
  const normalLayouts = layouts.filter(isNormalLayout);
  const nextLayouts = normalLayouts.length > 0 ? layouts : [createDefaultLayout(), ...layouts];
  const firstStarred = nextLayouts.find(isStarredLayout);
  const deduped = firstStarred
    ? nextLayouts.filter((layout) => !isStarredLayout(layout) || layout.id === firstStarred.id)
    : [...nextLayouts, createStarredLayout()];

  for (const layout of deduped) {
    if (isStarredLayout(layout)) {
      layout.name = STARRED_LAYOUT_NAME;
    } else if (!layout.kind) {
      layout.kind = "normal";
    }
  }

  return deduped;
}

export function ensureStarredLayoutInDraft(state: PanesDraft): string {
  const existing = findLayout(state.layouts, isStarredLayout);
  if (existing) {
    existing.name = STARRED_LAYOUT_NAME;
    return existing.id;
  }
  const layout = createStarredLayout();
  state.layouts.push(layout);
  return layout.id;
}

export function projectedLayouts(
  state: Pick<PanesState, "layouts" | "currentLayoutId" | "rootPane" | "activePaneId">,
  options: { includeStarred?: boolean } = {},
): LayoutEntry[] {
  const layouts = Array.isArray(state.layouts) ? state.layouts : [];
  if (layouts.length === 0) {
    return [{
      id: state.currentLayoutId || generateId("layout"),
      name: "布局 1",
      kind: "normal",
      rootPane: state.rootPane,
      activePaneId: state.activePaneId,
    }];
  }
  return layouts
    .filter((layout) => options.includeStarred || isNormalLayout(layout))
    .map((layout) => (
      layout.id === state.currentLayoutId && isNormalLayout(layout)
      ? {
          ...layout,
          rootPane: state.rootPane,
          activePaneId: state.activePaneId,
        }
      : layout
    ));
}

// 仅用于快照/持久化加载：压平运行期积累的单 child split 壳链。
// 运行期不得调用（会触发上述 remount）；导出侧（partialize /
// exportLayoutSnapshotPayload）持有活树引用，也不得原地压平。
export function flattenPaneTreeForImport(node: PaneNode): PaneNode {
  if (node.type === "panel") {
    for (const tab of node.tabs) {
      if (tab.contentType === "terminal" && tab.terminalRootPane) {
        tab.terminalRootPane = flattenTerminalPaneTreeForImport(tab.terminalRootPane);
      }
    }
    return node;
  }
  node.children = node.children.map((child) => flattenPaneTreeForImport(child));
  if (node.children.length === 1) return node.children[0];
  return node;
}

export function flattenTerminalPaneTreeForImport(node: TerminalPaneNode): TerminalPaneNode {
  if (node.type === "leaf") return node;
  node.children = node.children.map((child) => flattenTerminalPaneTreeForImport(child));
  if (node.children.length === 1) return node.children[0];
  return node;
}

/** Clean non-restorable runtime state after layout rehydration. */
export function cleanRehydratedPanes(node: PaneNode) {
  if (node.type === "panel") {
    for (const tab of node.tabs) {
      if (tab.contentType === "terminal") {
        syncTabTerminalState(tab);
        for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
          // 老快照没有 leaf.launchId：迁移时补一个稳定值，首次真正创建 PTY
          // 时 TerminalView 仍会换成新的 one-shot launch id。
          leaf.launchId ??= generateId("launch");
          leaf.restoreMode = resolveRestoreMode({
            cliTool: inferCliTool(
              leaf.cliTool ?? tab.cliTool,
              leaf.launchClaude,
              tab.launchClaude,
              leaf.resumeId,
              tab.resumeId,
            ),
            resumeId: leaf.resumeId,
            hasRestorableSession: Boolean(
              leaf.sessionId || leaf.savedSessionId || leaf.restoring,
            ),
          });
          if (leaf.sessionId) {
            leaf.savedSessionId = leaf.sessionId;
            leaf.restoring = true;
          }
          leaf.sessionId = null;
          if (leaf.resumeId === "new") {
            leaf.resumeId = undefined;
          }
          // restore 路径不得重放 initialPrompt（clearTabInitialPrompt 失败时的兜底）
          leaf.launchExtras = stripInitialPrompt(leaf.launchExtras);
        }
        tab.launchExtras = stripInitialPrompt(tab.launchExtras);
        syncTabTerminalState(tab);
      }
      if (tab.contentType === "editor") {
        tab.dirty = false;
      }
      if (tab.contentType === "dsh") {
        // dsh 的 URL 是每次进程启动由 OS 现分配的端口，**跨重启必然失效**。
        // 留着它会让窗格先拿死端口建一次 webview（`ERR_CONNECTION_REFUSED`
        // 的错误页），要等新实例起来回填才换掉。清空则直接落到
        // DshTabContent 的「正在启动」态，等真端口到位再渲染。
        tab.browserUrl = undefined;
      }
    }
  } else {
    node.children.forEach(cleanRehydratedPanes);
  }
}

export function ensureLayoutState(
  partial: Partial<Pick<PanesState, "layouts" | "currentLayoutId" | "rootPane" | "activePaneId">>
): Pick<PanesState, "layouts" | "currentLayoutId" | "rootPane" | "activePaneId"> {
  const validLayouts = Array.isArray(partial.layouts)
    ? filterLayouts(partial.layouts, (layout): layout is LayoutEntry => (
        Boolean(layout)
        && typeof layout.id === "string"
        && typeof layout.name === "string"
        && Boolean(layout.rootPane)
        && typeof layout.activePaneId === "string"
      ))
    : [];

  const layouts = ensureStarredLayout(validLayouts.length > 0
    ? validLayouts
    : [createDefaultLayout()]);

  for (const layout of layouts) {
    if (isStarredLayout(layout)) continue;
    layout.rootPane = flattenPaneTreeForImport(layout.rootPane);
    cleanRehydratedPanes(layout.rootPane);
    const active = findPane(layout.rootPane, layout.activePaneId);
    if (active?.type !== "panel") {
      layout.activePaneId = collectPanels(layout.rootPane)[0]?.id ?? layout.rootPane.id;
    }
  }

  const currentLayoutId = layouts.some((layout) => layout.id === partial.currentLayoutId && isNormalLayout(layout))
    ? partial.currentLayoutId!
    : firstNormalLayout(layouts)!.id;
  const current = layouts.find((layout) => layout.id === currentLayoutId) ?? firstNormalLayout(layouts)!;

  return {
    layouts,
    currentLayoutId,
    rootPane: current.rootPane,
    activePaneId: current.activePaneId,
  };
}
