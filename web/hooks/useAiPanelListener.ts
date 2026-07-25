import { useEffect } from "react";
import { aiPanelService } from "@/services/aiPanelService";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { useModulePrefsStore } from "@/stores/useModulePrefsStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import type { AiPanelChangedEvent } from "@/types/aiPanel";

export function applyAiPanelChange(change: AiPanelChangedEvent): void {
  if (change.operation === "close") {
    useAiPanelStore.getState().remove(change.panelId);
    if (useAiPanelStore.getState().panels.length === 0) {
      useDialogStore.getState().closeAiPanel();
      if (useRightDockStore.getState().activeView === "aiPanel") {
        useRightDockStore.getState().setActiveView("git");
      }
    }
    return;
  }
  if (!change.panel || change.panel.panelId !== change.panelId) return;

  const panelState = useAiPanelStore.getState();
  const rightDock = useRightDockStore.getState();
  const dialog = useDialogStore.getState();
  const viewingPanel = panelState.activePanelId === change.panelId && (
    dialog.aiPanelOpen
    || (rightDock.visible && rightDock.activeView === "aiPanel")
  );
  panelState.receive(change.panel, !viewingPanel);

  const preference = useModulePrefsStore.getState().preferences.aiPanel;
  if (!preference.enabled || !preference.autoOpen) return;
  if (preference.position === "rightDock") {
    useRightDockStore.setState({ visible: true, activeView: "aiPanel" });
  } else {
    useDialogStore.getState().openAiPanel();
  }
  useAiPanelStore.getState().selectPanel(change.panelId);
}

export function useAiPanelListener(): void {
  useEffect(() => {
    let cancelled = false;
    let ready = false;
    let unlisten: (() => void) | undefined;
    const pending: AiPanelChangedEvent[] = [];

    void (async () => {
      unlisten = await aiPanelService.listen((change) => {
        if (ready) applyAiPanelChange(change);
        else pending.push(change);
      });
      if (cancelled) {
        unlisten();
        return;
      }

      const panels = await aiPanelService.list();
      if (cancelled) return;
      useAiPanelStore.getState().hydrate(panels);
      pending.forEach(applyAiPanelChange);
      ready = true;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
