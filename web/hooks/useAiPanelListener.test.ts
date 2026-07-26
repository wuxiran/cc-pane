import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyAiPanelChange, decideAiPanelDelivery } from "@/hooks/useAiPanelListener";
import { aiPanelService } from "@/services/aiPanelService";
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

const ack = vi.spyOn(aiPanelService, "ackDelivery").mockResolvedValue();
const listHistory = vi.spyOn(aiPanelService, "listHistory").mockResolvedValue([]);

describe("applyAiPanelChange", () => {
  beforeEach(() => {
    useAiPanelStore.setState({
      panels: [],
      history: [],
      historyLoading: false,
      activePanelId: null,
      unreadPanelIds: [],
      view: "list",
    });
    useDialogStore.setState({ aiPanelOpen: false });
    useRightDockStore.setState({ visible: false, activeView: "git" });
    useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
    ack.mockClear();
    listHistory.mockClear();
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

  it("drops a closed panel back to the history list instead of ejecting the dock", () => {
    useAiPanelStore.getState().receive(panel, false);
    useAiPanelStore.getState().selectPanel(panel.panelId);
    useRightDockStore.setState({ visible: true, activeView: "aiPanel" });

    applyAiPanelChange({ operation: "close", panelId: panel.panelId });

    expect(useAiPanelStore.getState().panels).toEqual([]);
    // 内容仍在历史里，所以停在 AI 面板视图看历史，而不是被踢去 git
    expect(useRightDockStore.getState().activeView).toBe("aiPanel");
    expect(useAiPanelStore.getState().view).toBe("list");
    expect(listHistory).toHaveBeenCalled();
  });

  it("closes the modal dialog on close since an empty modal is intrusive", () => {
    useAiPanelStore.getState().receive(panel, false);
    useDialogStore.setState({ aiPanelOpen: true });

    applyAiPanelChange({ operation: "close", panelId: panel.panelId });

    expect(useDialogStore.getState().aiPanelOpen).toBe(false);
  });

  it("opens a dialog on explicit request even when auto-open is off", () => {
    applyAiPanelChange({
      operation: "open",
      panelId: panel.panelId,
      panel,
      display: "dialog",
      deliveryId: "delivery-1",
    });

    expect(useDialogStore.getState().aiPanelOpen).toBe(true);
    expect(useAiPanelStore.getState().unreadPanelIds).toEqual([]);
    expect(ack).toHaveBeenCalledWith("delivery-1", "dialog");
  });

  it("falls back to unread when the user revoked AI popup permission", () => {
    useModulePrefsStore.getState().setAllowAiDialog("aiPanel", false);

    applyAiPanelChange({
      operation: "open",
      panelId: panel.panelId,
      panel,
      display: "dialog",
      deliveryId: "delivery-2",
    });

    expect(useDialogStore.getState().aiPanelOpen).toBe(false);
    expect(useRightDockStore.getState().visible).toBe(false);
    expect(useAiPanelStore.getState().unreadPanelIds).toEqual(["panel-1"]);
    expect(ack).toHaveBeenCalledWith("delivery-2", "unread");
  });

  it("reports disabled when the module is turned off", () => {
    useModulePrefsStore.getState().setEnabled("aiPanel", false);

    applyAiPanelChange({
      operation: "open",
      panelId: panel.panelId,
      panel,
      display: "dialog",
      deliveryId: "delivery-3",
    });

    expect(useDialogStore.getState().aiPanelOpen).toBe(false);
    expect(ack).toHaveBeenCalledWith("delivery-3", "disabled");
  });

  it("honors silent even when auto-open is enabled", () => {
    useModulePrefsStore.getState().setAutoOpen("aiPanel", true);

    applyAiPanelChange({
      operation: "open",
      panelId: panel.panelId,
      panel,
      display: "silent",
      deliveryId: "delivery-4",
    });

    expect(useRightDockStore.getState().visible).toBe(false);
    expect(useDialogStore.getState().aiPanelOpen).toBe(false);
    expect(ack).toHaveBeenCalledWith("delivery-4", "unread");
  });

  it("skips the ack when the backend sent no deliveryId", () => {
    applyAiPanelChange({ operation: "open", panelId: panel.panelId, panel });

    expect(ack).not.toHaveBeenCalled();
  });
});

describe("decideAiPanelDelivery", () => {
  const base = { enabled: true, position: "rightDock" as const, autoOpen: false, allowAiDialog: true };

  it("routes auto through the user preference", () => {
    expect(decideAiPanelDelivery("auto", base)).toBe("unread");
    expect(decideAiPanelDelivery("auto", { ...base, autoOpen: true })).toBe("dock");
    expect(
      decideAiPanelDelivery("auto", { ...base, autoOpen: true, position: "activityBar" }),
    ).toBe("dialog");
  });

  it("lets an explicit request override auto-open", () => {
    expect(decideAiPanelDelivery("dialog", base)).toBe("dialog");
    expect(decideAiPanelDelivery("dock", base)).toBe("dock");
  });

  it("puts disabled ahead of every other rule", () => {
    expect(decideAiPanelDelivery("dialog", { ...base, enabled: false })).toBe("disabled");
    expect(decideAiPanelDelivery("silent", { ...base, enabled: false })).toBe("disabled");
  });

  it("treats a missing allowAiDialog as permitted", () => {
    expect(decideAiPanelDelivery("dialog", { enabled: true, position: "rightDock" })).toBe("dialog");
  });
});
