import type { CliTool } from "@/types";
import { usePanesStore } from "@/stores/usePanesStore";

interface InPlaceTarget { pageTabId: string; paneId: string; layoutId: string; projectPath: string }

/**
 * 新标签页里启动终端 / CLI：新终端落在新标签页原来的位置，新标签页本身关掉，
 * 效果等同于「这一页变成了终端」。找不到新标签页（已被关）时退回普通追加。
 */
export function launchTerminalInPlace(target: InPlaceTarget, cliTool: CliTool) {
  const store = usePanesStore.getState();
  const opts = { projectId: "", projectPath: target.projectPath, cliTool };
  const page = store.findTabAcrossLayouts(target.pageTabId);
  if (!page) {
    store.addTab(target.paneId, opts, target.layoutId);
    return;
  }
  const index = page.panel.tabs.findIndex((item) => item.id === target.pageTabId);
  store.addTab(page.panel.id, opts, page.layoutId);

  const after = usePanesStore.getState();
  const panel = after.findTabAcrossLayouts(target.pageTabId)?.panel;
  // reorderTabs 只认当前布局；新标签页在后台布局里时保持追加在末尾。
  if (panel && page.layoutId === after.currentLayoutId && panel.activeTabId) {
    const from = panel.tabs.findIndex((item) => item.id === panel.activeTabId);
    if (from >= 0 && from !== index) after.reorderTabs(panel.id, from, index);
  }
  after.removeTabsInternal([target.pageTabId], "user-close");
}
