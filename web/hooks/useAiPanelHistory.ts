import { aiPanelService } from "@/services/aiPanelService";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import type { AiPanel, StoredAiPanel } from "@/types/aiPanel";

function toLivePanel(stored: StoredAiPanel): AiPanel {
  return {
    panelId: stored.panelId,
    title: stored.title,
    format: stored.format,
    content: stored.content,
    driverName: stored.driverName,
    updatedAt: stored.updatedAt,
  };
}

/**
 * 打开一条历史面板。
 *
 * 已在活跃集里就直接聚焦（那份内容更新、且带着活的事件通道）；
 * 否则按需拉正文——列表刻意不带 content，正文最大 256 KiB。
 *
 * 返回是否成功，供调用方决定要不要提示。
 */
export async function openAiPanelFromHistory(panelId: string): Promise<boolean> {
  const store = useAiPanelStore.getState();
  if (store.panels.some((panel) => panel.panelId === panelId)) {
    store.selectPanel(panelId);
    return true;
  }

  const stored = await aiPanelService.getContent(panelId);
  if (!stored) return false;

  // 历史面板是快照：markUnread=false，用户是主动点开的，不该再标未读
  useAiPanelStore.getState().receive(toLivePanel(stored), false);
  useAiPanelStore.getState().selectPanel(panelId);
  return true;
}

/** 用户显式删除一条历史。历史不自动清理，这是唯一的删除路径。 */
export async function removeAiPanelFromHistory(panelId: string): Promise<boolean> {
  const deleted = await aiPanelService.deletePanel(panelId);
  if (deleted) useAiPanelStore.getState().forget(panelId);
  return deleted;
}
