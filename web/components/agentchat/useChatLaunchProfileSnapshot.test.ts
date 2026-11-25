import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPanel } from "@/lib/paneTree";
import { usePanesStore } from "@/stores";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useProvidersStore } from "@/stores/useProvidersStore";
import type { LaunchProfile } from "@/types/launch-profile";
import type { Panel } from "@/types";
import { useChatLaunchProfileSnapshot } from "./useChatLaunchProfileSnapshot";

vi.mock("@/services/launchProfileService", () => ({
  launchProfileService: { list: vi.fn().mockResolvedValue([]) },
}));

const work = { id: "p-work", name: "工作", targetTools: [], isDefault: false, modelId: "opus" } as unknown as LaunchProfile;

function openTab(): string {
  const panel = createPanel();
  usePanesStore.setState({
    rootPane: panel,
    activePaneId: panel.id,
    layouts: [{ id: "layout-1", name: "布局 1", rootPane: panel, activePaneId: panel.id }],
    currentLayoutId: "layout-1",
    closedTabs: [],
  });
  usePanesStore.getState().addTab(panel.id, { projectId: "p", projectPath: "/tmp/chat" });
  return (usePanesStore.getState().rootPane as Panel).tabs.find((tab) => tab.projectPath === "/tmp/chat")!.id;
}

describe("useChatLaunchProfileSnapshot", () => {
  beforeEach(() => {
    useLaunchProfilesStore.setState({ profiles: [work], loaded: true, loading: false });
    useProvidersStore.setState({ providers: [] });
  });

  it("records the session's profile on the tab and keeps it after the profile is deleted", async () => {
    const tabId = openTab();
    const { result } = renderHook(() => useChatLaunchProfileSnapshot(tabId, "p-work"));
    await waitFor(() => expect(result.current).toMatchObject({ launchProfileId: "p-work", name: "工作", model: "opus" }));

    act(() => {
      useLaunchProfilesStore.setState({ profiles: [] });
    });
    expect(result.current?.name).toBe("工作");
  });

  it("does nothing for system-default sessions", () => {
    const tabId = openTab();
    const { result } = renderHook(() => useChatLaunchProfileSnapshot(tabId, undefined));
    expect(result.current).toBeNull();
    expect(usePanesStore.getState().findTabAcrossLayouts(tabId)?.tab.launchProfileSnapshot).toBeUndefined();
  });

  it("ignores a snapshot recorded for a different profile", () => {
    const tabId = openTab();
    usePanesStore.getState().setTabLaunchProfileSnapshot(tabId, {
      launchProfileId: "p-old", name: "旧", model: null, capturedAt: "",
    });
    useLaunchProfilesStore.setState({ profiles: [] });
    const { result } = renderHook(() => useChatLaunchProfileSnapshot(tabId, "p-work"));
    expect(result.current).toBeNull();
  });
});
