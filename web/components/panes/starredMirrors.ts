import { collectTerminalLeaves } from "@/lib/paneSessions";
import type { Tab } from "@/types";

/** 星标 tab 的来源信息（原布局中的位置） */
export interface StarredShortcutSource {
  layoutId: string;
  layoutName: string;
  paneId: string;
  tab: Tab;
}

/**
 * 星标页的一个镜像格子。sessionId 为 null 表示会话未启动/恢复中/非终端 tab，
 * 渲染占位卡片而不挂 TerminalView。
 */
export interface StarredMirrorTileData {
  /** React key：sessionId 变化（重启恢复换新会话）→ remount 走 attach 连新会话 */
  key: string;
  tabId: string;
  title: string;
  layoutName: string;
  projectId: string;
  projectPath: string;
  sessionId: string | null;
}

/**
 * 把星标 shortcut 展平成镜像格子：分屏 tab 的每个终端 leaf 一个格子，
 * 普通 tab 一个格子。纯派生——原 tab 关闭/取消星标/换 sessionId 都自动生效。
 */
export function collectStarredMirrorTiles(
  shortcuts: StarredShortcutSource[],
): StarredMirrorTileData[] {
  const tiles: StarredMirrorTileData[] = [];
  for (const { layoutName, tab } of shortcuts) {
    const base = {
      tabId: tab.id,
      title: tab.title,
      layoutName,
      projectId: tab.projectId,
      projectPath: tab.projectPath,
    };
    if (tab.contentType === "terminal" && tab.terminalRootPane) {
      for (const leaf of collectTerminalLeaves(tab.terminalRootPane)) {
        tiles.push({
          ...base,
          key: `${tab.id}:${leaf.id}:${leaf.sessionId ?? "pending"}`,
          sessionId: leaf.sessionId,
        });
      }
      continue;
    }
    const sessionId = tab.contentType === "terminal" ? (tab.sessionId ?? null) : null;
    tiles.push({
      ...base,
      key: `${tab.id}:main:${sessionId ?? "pending"}`,
      sessionId,
    });
  }
  return tiles;
}

/** 自动排列：1 个全屏，2 个两列，3-4 四宫格，更多双列网格 + 滚动 */
export function mirrorGridClass(count: number): string {
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-2";
  if (count <= 4) return "grid-cols-2 grid-rows-2";
  return "grid-cols-2 auto-rows-[minmax(280px,1fr)]";
}
