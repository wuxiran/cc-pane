import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePanesStore, useQuickCommandsStore, useWorkspacesStore } from "@/stores";
import type { Tab, Workspace } from "@/types";
import { useQuickCommandsSync, workspaceNameForProject } from "./useQuickCommandsSync";

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
    // /repo/a 属于工作空间 alpha；/repo/b 不属于任何已注册工作空间
    useWorkspacesStore.setState({
      workspaces: [
        { id: "ws-alpha", name: "alpha", projects: [{ id: "p-a", path: "/repo/a" }] } as unknown as Workspace,
      ],
    });
  });

  it("reloads commands when the active tab project changes, carrying the owning workspace", async () => {
    renderHook(() => useQuickCommandsSync());

    await waitFor(() =>
      expect(load).toHaveBeenCalledWith({ projectPath: "/repo/a", workspaceName: "alpha" }),
    );

    act(() => usePanesStore.getState().selectTab("pane-quick-sync", "tab-b"));

    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith({ projectPath: "/repo/b", workspaceName: undefined }),
    );
  });

  it("workspaceNameForProject resolves by exact project path", () => {
    const workspaces = [{ name: "alpha", projects: [{ path: "/repo/a" }] }];
    expect(workspaceNameForProject(workspaces, "/repo/a")).toBe("alpha");
    expect(workspaceNameForProject(workspaces, "/repo/x")).toBeUndefined();
    expect(workspaceNameForProject(workspaces, undefined)).toBeUndefined();
  });
});
