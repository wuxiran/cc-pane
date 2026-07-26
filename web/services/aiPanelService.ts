import { invokeIfTauri, listenWebviewIfTauri } from "@/services/runtime";
import type {
  AiPanel,
  AiPanelChangedEvent,
  AiPanelDelivery,
  AiPanelSummary,
  StoredAiPanel,
} from "@/types/aiPanel";

export const AI_PANEL_CHANGED_EVENT = "ai-panel-changed";

export const aiPanelService = {
  async list(): Promise<AiPanel[]> {
    return (await invokeIfTauri<AiPanel[]>("list_ai_panels")) ?? [];
  },

  async recordEvent(
    panelId: string,
    action: string,
    payload?: unknown,
  ): Promise<void> {
    await invokeIfTauri<void>("record_ai_panel_event", {
      panelId,
      action,
      payload,
    });
  },

  /** 全部历史面板摘要（不含正文），按工作空间分组的排序已由后端给出。 */
  async listHistory(): Promise<AiPanelSummary[]> {
    return (await invokeIfTauri<AiPanelSummary[]>("list_ai_panel_history")) ?? [];
  },

  /** 按需取单条历史面板的正文。 */
  async getContent(panelId: string): Promise<StoredAiPanel | null> {
    return (await invokeIfTauri<StoredAiPanel | null>("get_ai_panel_content", { panelId })) ?? null;
  },

  /** 用户显式删除一条历史（历史不自动清理，这是唯一入口）。 */
  async deletePanel(panelId: string): Promise<boolean> {
    return (await invokeIfTauri<boolean>("delete_ai_panel", { panelId })) ?? false;
  },

  /**
   * 回执真实投递结果，让调用方（AI）知道面板到底展示了没有。
   * 复用通用的 pending_queries 应答通道，无需新增 Tauri 命令。
   */
  async ackDelivery(deliveryId: string, delivery: AiPanelDelivery): Promise<void> {
    await invokeIfTauri<void>("respond_orchestrator_query", {
      requestId: deliveryId,
      data: JSON.stringify({ delivery }),
    });
  },

  listen(handler: (event: AiPanelChangedEvent) => void) {
    return listenWebviewIfTauri<AiPanelChangedEvent>(AI_PANEL_CHANGED_EVENT, (event) => {
      handler(event.payload);
    });
  },
};
