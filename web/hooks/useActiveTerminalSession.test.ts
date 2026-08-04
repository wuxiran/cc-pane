import { describe, expect, it } from "vitest";
import type { Panel, Tab } from "@/types";
import {
  selectActiveTerminalContext,
  selectActiveTerminalLeaf,
  selectActiveTerminalSessionId,
} from "./useActiveTerminalSession";

function panel(tab: Tab): Panel {
  return { type: "panel", id: "panel-1", tabs: [tab], activeTabId: tab.id };
}

function tabWithTree(): Tab {
  return {
    id: "tab-1",
    title: "project",
    contentType: "terminal",
    projectId: "project-1",
    projectPath: "C:/project",
    sessionId: "old-tab-session",
    activeTerminalPaneId: "leaf-2",
    terminalRootPane: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "leaf", id: "leaf-1", sessionId: "session-1" },
        {
          type: "leaf",
          id: "leaf-2",
          sessionId: "session-2",
          cliTool: "codex",
          providerId: "provider-1",
          modelId: "model-1",
          providerSelection: "inherit",
          launchProfileId: "profile-1",
        },
      ],
    },
  };
}

describe("useActiveTerminalSession selectors", () => {
  it("follows activeTerminalPaneId instead of the tab-level legacy id", () => {
    const state = { rootPane: panel(tabWithTree()), activePaneId: "panel-1" };
    expect(selectActiveTerminalSessionId(state)).toBe("session-2");
    expect(selectActiveTerminalLeaf(state)?.id).toBe("leaf-2");
  });

  it("falls back to tab.sessionId only when no terminal tree exists", () => {
    const tab: Tab = {
      id: "tab-legacy",
      title: "legacy",
      contentType: "terminal",
      projectId: "project-1",
      projectPath: "C:/project",
      sessionId: "legacy-session",
      providerId: "legacy-provider",
      modelId: "legacy-model",
      providerSelection: "explicit",
      launchProfileId: "legacy-profile",
    };
    const state = {
      rootPane: panel(tab),
      activePaneId: "panel-1",
    };
    expect(selectActiveTerminalSessionId(state)).toBe("legacy-session");
    expect(selectActiveTerminalContext(state)).toMatchObject({
      providerId: "legacy-provider",
      modelId: "legacy-model",
      providerSelection: "explicit",
      launchProfileId: "legacy-profile",
    });
  });

  it("returns null for a non-terminal active tab", () => {
    const tab = tabWithTree();
    expect(selectActiveTerminalSessionId({
      rootPane: panel({ ...tab, contentType: "browser", browserUrl: "https://example.com" }),
      activePaneId: "panel-1",
    })).toBeNull();
  });

  it("exposes CLI and SSH metadata so unsupported sessions can skip polling", () => {
    const tab = tabWithTree();
    const state = {
      rootPane: panel(tab),
      activePaneId: "panel-1",
    };
    expect(selectActiveTerminalContext(state)).toMatchObject({
      sessionId: "session-2",
      cliTool: "codex",
      ssh: false,
      providerId: "provider-1",
      modelId: "model-1",
      providerSelection: "inherit",
      launchProfileId: "profile-1",
    });
  });
});
