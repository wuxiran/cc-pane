import { invokeIfTauri, listenWebviewIfTauri } from "@/services/runtime";
import type { AiPanel, AiPanelChangedEvent } from "@/types/aiPanel";

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

  listen(handler: (event: AiPanelChangedEvent) => void) {
    return listenWebviewIfTauri<AiPanelChangedEvent>(AI_PANEL_CHANGED_EVENT, (event) => {
      handler(event.payload);
    });
  },
};
