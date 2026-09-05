// 命令目标解析：ctx 显式指定优先，缺省回落到激活 pane 的激活标签。
import { usePanesStore } from "@/stores";
import type { CommandContext } from "./types";

export function resolvePaneTab(ctx: CommandContext) {
  const s = usePanesStore.getState();
  const paneId = ctx.paneId ?? s.activePaneId;
  const pane = paneId ? s.findPaneById(paneId) : null;
  if (pane?.type !== "panel") return null;
  const tabId = ctx.tabId ?? pane.activeTabId;
  const tab = pane.tabs.find((item) => item.id === tabId);
  return tab ? { pane, tab } : null;
}
