import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/apiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/apiClient")>();
  return {
    ...actual,
    invokeOrApi: (command: string, args: Record<string, unknown> | undefined, apiCall: () => Promise<unknown>) =>
      command === "prepare_claude_relaunch"
        ? prepareMock(args)
        : actual.invokeOrApi(command, args, apiCall),
  };
});

import { terminalService } from "@/services";
import { usePanesStore } from "@/stores/usePanesStore";
import { createPanel } from "@/lib/paneTree";
import { resetTestDataCounter } from "@/test/utils/testData";
import type { Panel, TerminalPaneLeaf } from "@/types";
import { relaunchClaudeTerminals } from "./relaunchClaudeTerminals";

function addClaudeTerminal(sessionId: string, resumeId?: string) {
  const paneId = usePanesStore.getState().rootPane.id;
  usePanesStore.getState().addTab(paneId, {
    projectId: "proj-1",
    projectPath: "/tmp/proj1",
    cliTool: "claude",
    resumeId,
  });
  usePanesStore.setState((state) => {
    const pane = state.rootPane as Panel;
    const tab = pane.tabs[pane.tabs.length - 1];
    const leaf = tab.terminalRootPane!;
    if (leaf.type !== "leaf") throw new Error("expected leaf");
    leaf.sessionId = sessionId;
    leaf.resumeId = resumeId;
    tab.sessionId = sessionId;
  });
  const pane = usePanesStore.getState().rootPane as Panel;
  return pane.tabs[pane.tabs.length - 1].id;
}

function leafOf(tabId: string): TerminalPaneLeaf {
  const tab = (usePanesStore.getState().rootPane as Panel).tabs.find((item) => item.id === tabId)!;
  const leaf = tab.terminalRootPane!;
  if (leaf.type !== "leaf") throw new Error("expected leaf");
  return leaf;
}

describe("relaunchClaudeTerminals", () => {
  beforeEach(() => {
    resetTestDataCounter();
    prepareMock.mockReset();
    const initialPanel = createPanel();
    usePanesStore.setState({
      rootPane: initialPanel,
      activePaneId: initialPanel.id,
      layouts: [{
        id: "layout-1",
        name: "布局 1",
        rootPane: initialPanel,
        activePaneId: initialPanel.id,
      }],
      currentLayoutId: "layout-1",
      closedTabs: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("先迁移 transcript，再以 reason=relaunch 杀旧会话并原位重开", async () => {
    const tabId = addClaudeTerminal("s-1", "r-1");
    prepareMock.mockResolvedValue({
      accountId: "acc-new",
      results: [{ resumeId: "r-1", status: "copied" }],
    });
    const kill = vi.spyOn(terminalService, "killSession").mockResolvedValue(undefined);

    const targets = usePanesStore.getState().collectClaudeRelaunchTargets();
    const summary = await relaunchClaudeTerminals(targets);

    expect(prepareMock).toHaveBeenCalledWith({ resumeIds: ["r-1"] });
    expect(kill).toHaveBeenCalledWith("s-1", "relaunch");
    expect(summary).toEqual({ accountId: "acc-new", relaunched: 1, failed: 0, migrated: 1, fresh: 0 });
    expect(leafOf(tabId).sessionId).toBeNull();
    expect(leafOf(tabId).launchAttempt).toBe(1);
  });

  it("迁移失败不阻断重启；kill 失败则接回旧会话并计入 failed", async () => {
    const okTab = addClaudeTerminal("s-1", "r-1");
    const failTab = addClaudeTerminal("s-2");
    prepareMock.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(terminalService, "killSession").mockImplementation(async (sessionId) => {
      if (sessionId === "s-2") throw new Error("kill failed");
    });

    const summary = await relaunchClaudeTerminals(usePanesStore.getState().collectClaudeRelaunchTargets());

    expect(summary).toMatchObject({ accountId: null, relaunched: 1, failed: 1, migrated: 0 });
    expect(leafOf(okTab).launchAttempt).toBe(1);
    expect(leafOf(failTab).sessionId).toBe("s-2");
    expect(leafOf(failTab).restoring).toBe(false);
  });
});
