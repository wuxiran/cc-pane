import { beforeEach, describe, expect, it } from "vitest";
import { applyAiPanelChange } from "@/hooks/useAiPanelListener";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import { useDialogStore } from "@/stores/useDialogStore";
import {
  createDefaultModulePreferences,
  useModulePrefsStore,
} from "@/stores/useModulePrefsStore";
import { useRightDockStore } from "@/stores/useRightDockStore";
import type { AiPanel } from "@/types/aiPanel";

const panel: AiPanel = {
  panelId: "panel-1",
  title: "Progress",
  format: "markdown",
  content: "# Working",
  driverName: "Worker A",
  updatedAt: "2026-07-25T10:00:00Z",
};

describe("applyAiPanelChange", () => {
  beforeEach(() => {
    useAiPanelStore.setState({ panels: [], activePanelId: null, unreadPanelIds: [] });
    useDialogStore.setState({ aiPanelOpen: false });
    useRightDockStore.setState({ visible: false, activeView: "git" });
    useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
  });

  it("marks a new panel unread without opening a surface by default", () => {
    applyAiPanelChange({ operation: "open", panelId: panel.panelId, panel });

    expect(useAiPanelStore.getState()).toMatchObject({
      activePanelId: "panel-1",
      unreadPanelIds: ["panel-1"],
    });
    expect(useRightDockStore.getState().visible).toBe(false);
    expect(useDialogStore.getState().aiPanelOpen).toBe(false);
  });

  it("opens the configured surface only when auto-open is enabled", () => {
    useModulePrefsStore.getState().setAutoOpen("aiPanel", true);

    applyAiPanelChange({ operation: "open", panelId: panel.panelId, panel });

    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "aiPanel",
    });
    expect(useAiPanelStore.getState().unreadPanelIds).toEqual([]);
  });

  it("removes a closed panel and leaves the AI dock view", () => {
    useAiPanelStore.getState().receive(panel, false);
    useRightDockStore.setState({ visible: true, activeView: "aiPanel" });

    applyAiPanelChange({ operation: "close", panelId: panel.panelId });

    expect(useAiPanelStore.getState().panels).toEqual([]);
    expect(useRightDockStore.getState().activeView).toBe("git");
  });
});
