// 布局卡片类型计数桁的分桶统计：按 tab 内容类型计数（与 layoutStatusSummary 的
// 「按会话状态计数」是两个正交维度，同为卡片的一行）。
//
// 带 paneId 是因为这一桁可点击导航——跳转要 selectTab(paneId, tabId)，只有 tab
// 本身不够。
//
// 两条必须沿用的既有规避：
// 1. starred 布局是镜像（panes/starredMirrors.ts），直接统计会重复计数 —— 调用方
//    传 `kind` 让本函数返回全零，与 LayoutTopBar 对 tabCount 的处理一致。
// 2. 当前布局的活树在 store 工作副本 `rootPane` 上，不在 `layouts[i].rootPane`，
//    调用方必须先按 `selected ? liveRootPane : layout.rootPane` 取树再传进来。
import { collectPanels } from "@/lib/paneTree";
import { TAB_CONTENT_GROUP, TAB_CONTENT_GROUPS } from "@/lib/tabContentType";
import type { TabContentGroup } from "@/lib/tabContentType";
import type { LayoutEntry, PaneNode } from "@/types";

/** 导航所需的最小引用：跳转要 paneId + tabId，标题用于多目标时的提示 */
export interface LayoutTabRef {
  tabId: string;
  paneId: string;
  title: string;
}

export interface LayoutTypeSummary {
  /** 每个分组下的 tab 引用，按面板顺序。空分组给空数组。 */
  groups: Record<TabContentGroup, LayoutTabRef[]>;
  /** 全类型 tab 总数 —— 各桁之和，卡片顶部的数字用它 */
  total: number;
}

const emptyGroups = (): Record<TabContentGroup, LayoutTabRef[]> => ({
  terminal: [],
  browser: [],
  files: [],
  tools: [],
});

export function deriveLayoutTypeSummary(
  rootPane: PaneNode,
  kind?: LayoutEntry["kind"],
): LayoutTypeSummary {
  if (kind === "starred") return { groups: emptyGroups(), total: 0 };

  const groups = emptyGroups();
  let total = 0;
  for (const panel of collectPanels(rootPane)) {
    for (const tab of panel.tabs) {
      const group = TAB_CONTENT_GROUP[tab.contentType];
      if (!group) continue;
      groups[group].push({ tabId: tab.id, paneId: panel.id, title: tab.title });
      total += 1;
    }
  }
  return { groups, total };
}

/** 非空分组，按固定顺序（终端 → 浏览器 → 文件 → 工具），供渲染直接遍历 */
export function nonEmptyGroups(
  summary: LayoutTypeSummary,
): Array<{ group: TabContentGroup; tabs: LayoutTabRef[] }> {
  return TAB_CONTENT_GROUPS.filter((group) => summary.groups[group].length > 0).map((group) => ({
    group,
    tabs: summary.groups[group],
  }));
}
