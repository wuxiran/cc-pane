import type { PaneNode, Panel, SplitPane, Tab } from "@/types";

/** 生成唯一 ID */
export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** 创建新的面板 */
export function createPanel(tab?: Tab): Panel {
  const id = generateId("pane");
  const defaultTab: Tab = tab || {
    id: generateId("tab"),
    title: "Terminal",
    contentType: "terminal",
    projectId: "",
    projectPath: "",
    sessionId: null,
  };
  return {
    type: "panel",
    id,
    tabs: [defaultTab],
    activeTabId: defaultTab.id,
  };
}

/** 创建新标签 */
export function createTab(
  projectId: string,
  projectPath: string,
  resumeId?: string,
  workspaceName?: string,
  providerId?: string
): Tab {
  const name = projectPath.split(/[/\\]/).pop() || "Terminal";
  let title = name;
  if (resumeId === "new") {
    title = `${name} (Claude)`;
  } else if (resumeId) {
    title = `${name} (resume)`;
  }
  return {
    id: generateId("tab"),
    title,
    contentType: "terminal",
    projectId,
    projectPath,
    sessionId: null,
    resumeId,
    workspaceName,
    providerId,
  };
}

/** 递归查找面板 */
export function findPane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.id === paneId) return node;
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findPane(child, paneId);
      if (found) return found;
    }
  }
  return null;
}

/** 查找父节点 */
export function findParent(
  node: PaneNode,
  paneId: string,
  parent: SplitPane | null = null
): { parent: SplitPane | null; index: number } | null {
  if (node.id === paneId) {
    return { parent, index: parent ? parent.children.indexOf(node) : -1 };
  }
  if (node.type === "split") {
    for (let i = 0; i < node.children.length; i++) {
      const result = findParent(node.children[i], paneId, node);
      if (result) return result;
    }
  }
  return null;
}

/** 获取所有面板（扁平化） */
export function collectPanels(node: PaneNode): Panel[] {
  if (node.type === "panel") return [node];
  return node.children.flatMap(collectPanels);
}
