// 运行配置快照：会话建好后拍下「实际用的那个配置」，之后默认配置换了 / 配置被删 /
// 恢复 / 复制 / 跨端布局同步，标签上看到的都还是启动时那一份。
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePanesStore } from "../usePanesStore";
import { useLaunchProfilesStore } from "../useLaunchProfilesStore";
import { useProvidersStore } from "../useProvidersStore";
import { useWorkspacesStore } from "../useWorkspacesStore";
import { createPanel } from "@/lib/paneTree";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { resetTerminalLeafForRelaunch } from "@/lib/tabLifecycle/terminalLeafReset";
import { launchProfileIdForLaunch } from "@/lib/launchProfileSnapshot";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { LaunchProfile } from "@/types/launch-profile";
import type { Panel, Tab } from "@/types";

vi.mock("@/services/launchProfileService", () => ({
  launchProfileService: { list: vi.fn().mockResolvedValue([]) },
}));

function profile(overrides: Partial<LaunchProfile>): LaunchProfile {
  return { id: "p1", name: "工作", targetTools: [], isDefault: false, ...overrides } as unknown as LaunchProfile;
}

const work = profile({ id: "p-work", name: "工作", isDefault: true, modelId: "opus" });
const personal = profile({ id: "p-personal", name: "个人", isDefault: false });

function resetStore(): string {
  const panel = createPanel();
  usePanesStore.setState({
    rootPane: panel,
    activePaneId: panel.id,
    layouts: [{ id: "layout-1", name: "布局 1", rootPane: panel, activePaneId: panel.id }],
    currentLayoutId: "layout-1",
    closedTabs: [],
  });
  return panel.id;
}

function testTab(): Tab {
  return (usePanesStore.getState().rootPane as Panel).tabs.find((tab) => tab.projectPath === "/tmp/proj1")!;
}

function testLeaf() {
  return collectTerminalLeaves(testTab().terminalRootPane!)[0];
}

function openTab(extra: Record<string, unknown> = {}) {
  const paneId = resetStore();
  usePanesStore.getState().addTab(paneId, { projectId: "proj-1", projectPath: "/tmp/proj1", cliTool: "claude", ...extra });
  return paneId;
}

describe("captureTerminalLaunchProfileSnapshot", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useLaunchProfilesStore.setState({ profiles: [work, personal], loaded: true, loading: false });
    useProvidersStore.setState({ providers: [] });
    useWorkspacesStore.setState({ workspaces: [] });
  });

  it("records the default profile a launch fell back to, on leaf and tab", async () => {
    openTab();
    const leaf = testLeaf();
    await usePanesStore.getState().captureTerminalLaunchProfileSnapshot(testTab().id, leaf.id, leaf.launchId);
    expect(testLeaf().launchProfileSnapshot).toMatchObject({ launchProfileId: "p-work", name: "工作", implicitDefault: true, model: "opus" });
    expect(testTab().launchProfileSnapshot?.launchProfileId).toBe("p-work");
  });

  it("runs after the provider-account sync of a created session", async () => {
    openTab({ launchProfileId: "p-personal" });
    const leaf = testLeaf();
    mockTauriInvoke({ find_launch_history_by_launch_id: null });
    usePanesStore.getState().syncTerminalProviderAccount(testTab().id, leaf.id, leaf.launchId!);
    await vi.waitFor(() => expect(testLeaf().launchProfileSnapshot?.launchProfileId).toBe("p-personal"));
  });

  it("ignores a stale launch id", async () => {
    openTab();
    const leaf = testLeaf();
    await usePanesStore.getState().captureTerminalLaunchProfileSnapshot(testTab().id, leaf.id, "launch-old");
    expect(testLeaf().launchProfileSnapshot).toBeUndefined();
  });

  it("skips plain shells", async () => {
    openTab({ cliTool: "none" });
    await usePanesStore.getState().captureTerminalLaunchProfileSnapshot(testTab().id);
    expect(testLeaf().launchProfileSnapshot).toBeUndefined();
  });

  it("restore keeps the original profile even after the default changed", async () => {
    openTab();
    const leaf = testLeaf();
    await usePanesStore.getState().captureTerminalLaunchProfileSnapshot(testTab().id, leaf.id, leaf.launchId);
    const original = testLeaf().launchProfileSnapshot!;

    // 默认配置换成「个人」之后重新建会话（恢复）：传给后端的仍是原配置，快照原样沿用。
    useLaunchProfilesStore.setState({ profiles: [{ ...work, isDefault: false }, { ...personal, isDefault: true }] });
    expect(launchProfileIdForLaunch(testLeaf())).toBe("p-work");
    await usePanesStore.getState().captureTerminalLaunchProfileSnapshot(testTab().id, leaf.id);
    expect(testLeaf().launchProfileSnapshot).toEqual(original);
  });

  it("does not overwrite the snapshot when profiles cannot be loaded", async () => {
    openTab({ launchProfileSnapshot: { launchProfileId: "p-gone", name: "旧配置", model: null, capturedAt: "x" } });
    useLaunchProfilesStore.setState({ profiles: [], loaded: false });
    const { launchProfileService } = await import("@/services/launchProfileService");
    vi.mocked(launchProfileService.list).mockRejectedValueOnce(new Error("offline"));
    await usePanesStore.getState().captureTerminalLaunchProfileSnapshot(testTab().id);
    expect(testLeaf().launchProfileSnapshot?.name).toBe("旧配置");
  });
});

describe("launch profile snapshot travels with the tab", () => {
  const snapshot = { launchProfileId: "p-work", name: "工作", model: "opus", capturedAt: "2026-11-25T00:00:00.000Z" };

  beforeEach(() => {
    resetTauriInvoke();
  });

  it("clone / split relaunch keeps the snapshot", () => {
    openTab({ launchProfileSnapshot: snapshot });
    expect(testLeaf().launchProfileSnapshot).toEqual(snapshot);
    expect(resetTerminalLeafForRelaunch(testLeaf()).launchProfileSnapshot).toEqual(snapshot);
  });

  it("reopening a closed tab restores the snapshot", () => {
    const paneId = openTab({ launchProfileSnapshot: snapshot });
    usePanesStore.getState().removeTabsInternal([testTab().id], "user-close");
    usePanesStore.getState().reopenClosedTab(paneId);
    expect(testLeaf().launchProfileSnapshot).toEqual(snapshot);
  });

  it("survives the layout snapshot payload round trip (cross-device sync)", () => {
    openTab({ launchProfileSnapshot: snapshot });
    const payload = JSON.parse(JSON.stringify(usePanesStore.getState().exportLayoutSnapshotPayload()));
    resetStore();
    expect(usePanesStore.getState().applyLayoutSnapshotPayload(payload)).toBe(true);
    expect(testLeaf().launchProfileSnapshot).toEqual(snapshot);
    expect(testTab().launchProfileSnapshot).toEqual(snapshot);
  });

  it("old tabs without a snapshot stay without one", () => {
    openTab();
    expect(testLeaf().launchProfileSnapshot).toBeUndefined();
  });

  it("setTabLaunchProfileSnapshot writes onto the tab itself (Agent Chat path)", () => {
    openTab();
    usePanesStore.getState().setTabLaunchProfileSnapshot(testTab().id, snapshot);
    expect(testTab().launchProfileSnapshot).toEqual(snapshot);
  });
});
