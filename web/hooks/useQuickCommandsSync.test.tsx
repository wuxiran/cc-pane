import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePanesStore, useQuickCommandsStore } from "@/stores";
import type { Tab } from "@/types";
import { useQuickCommandsSync } from "./useQuickCommandsSync";

function tab(id: string, projectPath: string): Tab {
  return {
    id,
    title: id,
    contentType: "terminal",
    projectId: id,
    projectPath,
    sessionId: `${id}-session`,
  };
}

describe("useQuickCommandsSync", () => {
  const load = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    const first = tab("tab-a", "/repo/a");
    const second = tab("tab-b", "/repo/b");
    usePanesStore.setState({
      rootPane: {
        type: "panel",
        id: "pane-quick-sync",
        tabs: [first, second],
        activeTabId: first.id,
      },
      activePaneId: "pane-quick-sync",
    });
    useQuickCommandsStore.setState({ load });
  });

  it("reloads commands when the active tab project changes", async () => {
    renderHook(() => useQuickCommandsSync());

    await waitFor(() => expect(load).toHaveBeenCalledWith("/repo/a"));

    act(() => usePanesStore.getState().selectTab("pane-quick-sync", "tab-b"));

    await waitFor(() => expect(load).toHaveBeenLastCalledWith("/repo/b"));
  });
});
