import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  openAiPanelFromHistory,
  removeAiPanelFromHistory,
} from "@/hooks/useAiPanelHistory";
import { aiPanelService } from "@/services/aiPanelService";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import type { AiPanel, AiPanelSummary, StoredAiPanel } from "@/types/aiPanel";

const livePanel: AiPanel = {
  panelId: "live-1",
  title: "Live",
  format: "html",
  content: "<p>fresh</p>",
  driverName: "Worker A",
  updatedAt: "2026-07-26T12:00:00Z",
};

const stored: StoredAiPanel = {
  panelId: "old-1",
  workspaceName: "alpha",
  projectPath: "D:/repo",
  title: "Archived",
  format: "html",
  content: "<p>snapshot</p>",
  driverName: "Worker B",
  ownerSessionId: null,
  createdAt: "2026-07-20T10:00:00Z",
  updatedAt: "2026-07-20T10:00:00Z",
};

const summary: AiPanelSummary = {
  panelId: "old-1",
  workspaceName: "alpha",
  projectPath: "D:/repo",
  title: "Archived",
  format: "html",
  driverName: "Worker B",
  ownerSessionId: null,
  contentBytes: 18,
  createdAt: "2026-07-20T10:00:00Z",
  updatedAt: "2026-07-20T10:00:00Z",
};

const getContent = vi.spyOn(aiPanelService, "getContent");
const deletePanel = vi.spyOn(aiPanelService, "deletePanel");

describe("openAiPanelFromHistory", () => {
  beforeEach(() => {
    useAiPanelStore.setState({
      panels: [],
      history: [],
      historyLoading: false,
      activePanelId: null,
      unreadPanelIds: [],
      view: "list",
    });
    getContent.mockReset();
    deletePanel.mockReset();
  });

  it("focuses an already-live panel without refetching its content", async () => {
    useAiPanelStore.getState().receive(livePanel, true);

    await expect(openAiPanelFromHistory("live-1")).resolves.toBe(true);

    expect(getContent).not.toHaveBeenCalled();
    expect(useAiPanelStore.getState().view).toBe("detail");
    expect(useAiPanelStore.getState().activePanelId).toBe("live-1");
  });

  it("fetches the snapshot on demand for an archived panel", async () => {
    getContent.mockResolvedValue(stored);

    await expect(openAiPanelFromHistory("old-1")).resolves.toBe(true);

    expect(getContent).toHaveBeenCalledWith("old-1");
    const state = useAiPanelStore.getState();
    expect(state.panels.map((panel) => panel.panelId)).toEqual(["old-1"]);
    expect(state.view).toBe("detail");
    // 用户主动点开的，不该再标未读
    expect(state.unreadPanelIds).toEqual([]);
  });

  it("reports failure when the row is already gone", async () => {
    getContent.mockResolvedValue(null);

    await expect(openAiPanelFromHistory("missing")).resolves.toBe(false);
    expect(useAiPanelStore.getState().panels).toEqual([]);
  });
});

describe("removeAiPanelFromHistory", () => {
  beforeEach(() => {
    useAiPanelStore.setState({
      panels: [],
      history: [summary],
      historyLoading: false,
      activePanelId: null,
      unreadPanelIds: [],
      view: "list",
    });
    deletePanel.mockReset();
  });

  it("forgets the panel across both the live set and history", async () => {
    useAiPanelStore.getState().receive({ ...livePanel, panelId: "old-1" }, true);
    useAiPanelStore.getState().selectPanel("old-1");
    deletePanel.mockResolvedValue(true);

    await expect(removeAiPanelFromHistory("old-1")).resolves.toBe(true);

    const state = useAiPanelStore.getState();
    expect(state.history).toEqual([]);
    expect(state.panels).toEqual([]);
    expect(state.unreadPanelIds).toEqual([]);
    // 删掉的正是在看的那个，退回列表而不是停在空详情
    expect(state.view).toBe("list");
    expect(state.activePanelId).toBeNull();
  });

  it("keeps local state untouched when the backend deleted nothing", async () => {
    deletePanel.mockResolvedValue(false);

    await expect(removeAiPanelFromHistory("old-1")).resolves.toBe(false);
    expect(useAiPanelStore.getState().history).toEqual([summary]);
  });
});
