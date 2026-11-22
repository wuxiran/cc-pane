// 建完会话后，tab 记下后端解析出的「实际用的账号」。
//
// 没点名账号启动时用的是供应商当时的默认账号；不把它记到 tab 上，之后默认账号一换，
// 恢复 / 续接就会跑到另一个 CLI 配置目录里去找这段对话。
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePanesStore } from "../usePanesStore";
import { createPanel } from "@/lib/paneTree";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { Panel, Tab } from "@/types";

function resetStore(): string {
  const initialPanel = createPanel();
  usePanesStore.setState({
    rootPane: initialPanel,
    activePaneId: initialPanel.id,
    layouts: [{ id: "layout-1", name: "布局 1", rootPane: initialPanel, activePaneId: initialPanel.id }],
    currentLayoutId: "layout-1",
    closedTabs: [],
  });
  return initialPanel.id;
}

// createPanel 自带一个默认 shell 标签，所以按项目路径找被测的那个。
function onlyTab(): Tab {
  return (usePanesStore.getState().rootPane as Panel).tabs.find((tab) => tab.projectPath === "/tmp/proj1")!;
}

function onlyLeaf() {
  return collectTerminalLeaves(onlyTab().terminalRootPane!)[0];
}

function openTab(providerAccountId?: string) {
  const paneId = resetStore();
  usePanesStore.getState().addTab(paneId, {
    projectId: "proj-1",
    projectPath: "/tmp/proj1",
    cliTool: "claude",
    providerId: "prov-1",
    providerAccountId,
  });
}

describe("syncTerminalProviderAccount", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  it("新开的 tab 把请求里点名的账号带到 leaf 和 tab 上", () => {
    openTab("account-work");
    expect(onlyLeaf().providerAccountId).toBe("account-work");
    expect(onlyTab().providerAccountId).toBe("account-work");
  });

  it("没点名账号时，写回启动历史里后端解析出的账号", async () => {
    openTab();
    const leaf = onlyLeaf();
    mockTauriInvoke({ find_launch_history_by_launch_id: { id: 1, providerAccountId: "account-default" } });

    usePanesStore.getState().syncTerminalProviderAccount(onlyTab().id, leaf.id, leaf.launchId!);

    await vi.waitFor(() => expect(onlyLeaf().providerAccountId).toBe("account-default"));
    expect(onlyTab().providerAccountId).toBe("account-default");
  });

  it("供应商是继承来的：把解析出的供应商和账号成对写回，之后默认供应商换了也回到原来那家", async () => {
    const paneId = resetStore();
    usePanesStore.getState().addTab(paneId, {
      projectId: "proj-1",
      projectPath: "/tmp/proj1",
      cliTool: "claude",
    });
    const leaf = onlyLeaf();
    expect(leaf.providerId).toBeUndefined();
    mockTauriInvoke({
      find_launch_history_by_launch_id: { id: 1, providerId: "provider-a", providerAccountId: "default" },
    });

    usePanesStore.getState().syncTerminalProviderAccount(onlyTab().id, leaf.id, leaf.launchId!);

    await vi.waitFor(() => expect(onlyLeaf().providerAccountId).toBe("default"));
    expect(onlyLeaf().providerId).toBe("provider-a");
    expect(onlyTab().providerId).toBe("provider-a");
  });

  it("旧记录没有账号时保持原样", async () => {
    openTab("account-work");
    const leaf = onlyLeaf();
    mockTauriInvoke({ find_launch_history_by_launch_id: { id: 1, providerAccountId: null } });

    usePanesStore.getState().syncTerminalProviderAccount(onlyTab().id, leaf.id, leaf.launchId!);
    await Promise.resolve();
    await Promise.resolve();

    expect(onlyLeaf().providerAccountId).toBe("account-work");
  });

  it("leaf 已经换了 launchId（重新启动过）时不写旧结果", async () => {
    openTab();
    const leaf = onlyLeaf();
    const staleLaunchId = leaf.launchId!;
    mockTauriInvoke({ find_launch_history_by_launch_id: { id: 1, providerAccountId: "account-stale" } });
    usePanesStore.getState().updateTerminalLaunchId(onlyTab().id, leaf.id, "launch-newer");

    usePanesStore.getState().syncTerminalProviderAccount(onlyTab().id, leaf.id, staleLaunchId);
    await Promise.resolve();
    await Promise.resolve();

    expect(onlyLeaf().providerAccountId).toBeUndefined();
  });
});
