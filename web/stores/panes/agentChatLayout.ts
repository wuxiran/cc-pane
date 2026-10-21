// Agent Chat 专用固定布局的构造与归拢纯函数。
// 供给点：store 初始化与持久化 rehydrate（ensureLayoutState）；归拢点：rehydrate
// 时把散落在其他布局里的 agent-chat 标签搬回专用布局（幂等）。
// 路由（openAgentChat）、删除/移动守卫在各 action 处，本文件只管数据形状。
import type { LayoutEntry, PaneNode, Tab } from "@/types";
import { AGENT_CHAT_LAYOUT_ID } from "@/types";
import { collectPanels, createPanel } from "@/lib/paneTree";
import { createTabOfType } from "@/lib/tabLifecycle/tabFactory";
import { isNormalLayout } from "../paneLayoutHelpers";

export const AGENT_CHAT_LAYOUT_NAME = "Agent Chat";

export function isAgentChatLayout(layout: Pick<LayoutEntry, "id">): boolean {
  return layout.id === AGENT_CHAT_LAYOUT_ID;
}

/** Chat-local documents and configuration panels belong to the same workbench. */
export function isAgentChatWorkbenchTab(tab: Pick<Tab, "contentType">): boolean {
  return tab.contentType === "agent-chat" || tab.contentType === "editor"
    || tab.contentType === "file-explorer" || tab.contentType === "skill-manager"
    || tab.contentType === "mcp-config";
}

export function createAgentChatLayout(): LayoutEntry {
  const rootPane = createPanel();
  return {
    id: AGENT_CHAT_LAYOUT_ID,
    name: AGENT_CHAT_LAYOUT_NAME,
    kind: "normal",
    rootPane,
    activePaneId: rootPane.id,
  };
}

/** 缺失即供给（幂等），返回专用布局实例。直接 mutate 传入数组（immer/普通数组皆宜）。 */
export function ensureAgentChatLayout(layouts: LayoutEntry[]): LayoutEntry {
  const existing = layouts.find(isAgentChatLayout);
  if (existing) return existing;
  const created = createAgentChatLayout();
  layouts.push(created);
  return created;
}

/**
 * 专用布局保留对话、文件预览与聊天配置页；混入的终端等类型搬去第一个 CLI 布局。
 * 每个面板至少保留一个对话入口，关闭最后一个对话后不丢失已打开的文件。
 *
 * 调用点都是「别名干净」的时机：rehydrate（纯对象）、switchLayout / removeTabs
 * 的 set 收尾（当前布局工作副本刚与条目树对齐）。当前布局的树真源是 rootPane
 * 工作副本，非当前布局用条目树——与 resolveLayoutWriteTarget 同口径。
 */
export function enforceAgentChatLayoutPurity(state: {
  layouts: LayoutEntry[];
  currentLayoutId: string;
  rootPane: PaneNode;
}): void {
  const reserved = state.layouts.find(isAgentChatLayout);
  if (!reserved) return;
  const reservedIsCurrent = reserved.id === state.currentLayoutId;
  const tree = reservedIsCurrent ? state.rootPane : reserved.rootPane;
  const cli = state.layouts.find(
    (layout) => layout.id !== AGENT_CHAT_LAYOUT_ID && isNormalLayout(layout),
  );
  const cliPanels = cli ? collectPanels(cli.rootPane) : [];
  for (const panel of collectPanels(tree)) {
    const stayed: Tab[] = [];
    for (const tab of panel.tabs) {
      if (isAgentChatWorkbenchTab(tab)) {
        stayed.push(tab);
      } else if (cliPanels.length > 0) {
        cliPanels[0].tabs.push(tab);
      }
    }
    const moved = panel.tabs.length - stayed.length;
    if (moved > 0) {
      const lostActive = !stayed.some((tab) => tab.id === panel.activeTabId);
      panel.tabs = stayed;
      if (lostActive && stayed.length > 0) panel.activeTabId = stayed[0].id;
    }
    if (!panel.tabs.some((tab) => tab.contentType === "agent-chat")) {
      const fresh = createTabOfType("agent-chat", { projectPath: "" });
      panel.tabs.push(fresh);
      if (!panel.tabs.some((tab) => tab.id === panel.activeTabId)) panel.activeTabId = fresh.id;
    }
  }
  // 当前布局时把修正后的树写回条目（此刻别名干净，写回即同步）。
  if (reservedIsCurrent) reserved.rootPane = tree;
}
/** 把其他布局里的 agent-chat 标签归拢进专用布局（幂等，rehydrate 用）。 */
export function sweepAgentChatTabsToReservedLayout(layouts: LayoutEntry[]): number {
  const reserved = layouts.find(isAgentChatLayout);
  if (!reserved) return 0;
  const target = collectPanels(reserved.rootPane)[0];
  if (!target) return 0;
  let moved = 0;
  for (const layout of layouts) {
    if (isAgentChatLayout(layout)) continue;
    for (const panel of collectPanels(layout.rootPane)) {
      const stayed: Tab[] = [];
      for (const tab of panel.tabs) {
        if (tab.contentType === "agent-chat") {
          target.tabs.push(tab);
          moved += 1;
        } else {
          stayed.push(tab);
        }
      }
      const movedHere = panel.tabs.length - stayed.length;
      if (movedHere === 0) continue;
      const lostActive = !stayed.some((tab) => tab.id === panel.activeTabId);
      panel.tabs = stayed;
      if (lostActive && stayed.length > 0) panel.activeTabId = stayed[0].id;
    }
  }
  if (moved > 0) {
    target.activeTabId = target.tabs[target.tabs.length - 1]?.id ?? target.activeTabId;
    reserved.activePaneId = target.id;
  }
  return moved;
}
