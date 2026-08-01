import type { LayoutEntry, PaneNode, Tab } from "@/types";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { collectPanels, generateId } from "./paneTreeHelpers";

/**
 * usePanesStore 持久化快照的版本迁移（v1 → v5）。
 *
 * 从 store 抽出：这些是一次性的历史数据形状转换，与运行时行为无关，混在 store 里
 * 只会让本就很大的文件更难读。`syncTabTerminalState` 由调用方注入——它是 store 内部
 * 的 tab↔leaf 同步不变量，不宜再复制一份到这里。
 */
export interface PanesMigrationDeps {
  syncTabTerminalState: (tab: Tab) => void;
}

export function migratePersistedPanes(
  persistedState: unknown,
  version: number,
  deps: PanesMigrationDeps,
): Record<string, unknown> {
  const { syncTabTerminalState } = deps;
  const state = persistedState as Record<string, unknown>;

  if (version < 2) {
    // v1 -> v2: migrate launchClaude=true tabs to cliTool="claude"
    const migrateNode = (node: PaneNode) => {
      if (node.type === "panel") {
        for (const tab of node.tabs) {
          if (!tab.cliTool && tab.launchClaude) {
            tab.cliTool = "claude";
          }
        }
      } else {
        node.children.forEach(migrateNode);
      }
    };
    if (state.rootPane) {
      migrateNode(state.rootPane as PaneNode);
    }
  }

  if (version < 3 && state.rootPane) {
    const migrateTerminalTabs = (node: PaneNode) => {
      if (node.type === "panel") {
        for (const tab of node.tabs) {
          if (tab.contentType === "terminal") {
            syncTabTerminalState(tab);
          }
        }
      } else {
        node.children.forEach(migrateTerminalTabs);
      }
    };
    migrateTerminalTabs(state.rootPane as PaneNode);
  }

  if (version < 4 && state.rootPane) {
    const rootPane = state.rootPane as PaneNode;
    const activePaneId = typeof state.activePaneId === "string"
      ? state.activePaneId
      : collectPanels(rootPane)[0]?.id ?? rootPane.id;
    state.layouts = [{
      id: generateId("layout"),
      name: "布局 1",
      kind: "normal",
      rootPane,
      activePaneId,
    }];
    state.currentLayoutId = (state.layouts as LayoutEntry[])[0].id;
    delete state.rootPane;
    delete state.activePaneId;
  }

  // v5: every terminal leaf owns a launch identity. Keep this migration
  // tolerant of snapshots that were written before terminal subpanes existed.
  const migrateLaunchIds = (node: PaneNode) => {
    if (node.type === "panel") {
      for (const tab of node.tabs) {
        if (tab.contentType === "terminal") {
          syncTabTerminalState(tab);
          for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
            leaf.launchId ??= generateId("launch");
          }
        }
      }
      return;
    }
    node.children.forEach(migrateLaunchIds);
  };
  if (state.rootPane) migrateLaunchIds(state.rootPane as PaneNode);
  if (Array.isArray(state.layouts)) {
    for (const layout of state.layouts as LayoutEntry[]) {
      if (layout?.rootPane) migrateLaunchIds(layout.rootPane);
    }
  }

  return state;
}
