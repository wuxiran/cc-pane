// 一次性迁移：旧版「Agent Chat 专用布局」（id = layout-agent-chat）退役。
// 现在 Agent Chat 标签与终端等其它标签一样开在任意普通布局里，这个 id 不再特殊。
// 只在持久化快照 v5 → v6 时调用（panesPersistMigrations），运行时代码不认这个 id。
import type { LayoutEntry, PaneNode, Tab } from "@/types";
import { collectPanels } from "@/lib/paneTree";

export const LEGACY_AGENT_CHAT_LAYOUT_ID = "layout-agent-chat";
const DEFAULT_AGENT_CHAT_TITLE = "Agent Chat";

/**
 * 「空白新对话」：旧专用布局自动补出来、用户从没动过的 agent-chat 标签。
 * 判据全部来自持久化的标签字段（对话内容在内存 store / 后端历史里，不随标签持久化）：
 * 没有 cwd、没有预选引擎、不是分叉出来的、标题仍是默认值。任一字段有值即视为「在用」。
 */
export function isBlankAgentChatTab(tab: Tab): boolean {
  if (tab.contentType !== "agent-chat") return false;
  if (tab.projectPath || tab.agentEngineId || tab.parentTabId || tab.forkReviewId) return false;
  const title = tab.title?.trim() ?? "";
  return title === "" || title === DEFAULT_AGENT_CHAT_TITLE;
}

/** 空壳布局：单个窗格（未分屏），里面没有标签或只有一个空白新对话。 */
export function isBlankLegacyAgentChatLayout(rootPane: PaneNode): boolean {
  if (rootPane.type !== "panel") return false;
  const panels = collectPanels(rootPane);
  if (panels.length !== 1) return false;
  const tabs = panels[0].tabs;
  return tabs.length === 0 || (tabs.length === 1 && isBlankAgentChatTab(tabs[0]));
}

/**
 * 原地改写持久化快照：空壳则删除旧专用布局，否则原样保留为普通布局（名字、id 不变）。
 * 删除后 currentLayoutId 若悬空，指向第一个剩余普通布局；一个普通布局都不剩时交给
 * ensureLayoutState 补默认布局。
 */
export function migrateLegacyAgentChatLayout(state: Record<string, unknown>): void {
  if (!Array.isArray(state.layouts)) return;
  const layouts = state.layouts as LayoutEntry[];
  const legacy = layouts.find((layout) => layout?.id === LEGACY_AGENT_CHAT_LAYOUT_ID);
  if (!legacy?.rootPane || !isBlankLegacyAgentChatLayout(legacy.rootPane)) return;
  const remaining = layouts.filter((layout) => layout !== legacy);
  state.layouts = remaining;
  if (state.currentLayoutId === LEGACY_AGENT_CHAT_LAYOUT_ID) {
    state.currentLayoutId = remaining.find((layout) => layout?.kind !== "starred")?.id;
  }
}
