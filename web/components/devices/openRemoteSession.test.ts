import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSummary } from "@/types/device";

vi.mock("@/services/deviceService", () => ({
  attachDeviceSession: vi.fn(async () => undefined),
  createDeviceSession: vi.fn(async () => "remote-new"),
}));

import { attachDeviceSession, createDeviceSession } from "@/services/deviceService";
import { collectPanels } from "@/lib/paneTree";
import { usePanesStore } from "@/stores/usePanesStore";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import { openRemoteSession, startRemoteSession } from "./openRemoteSession";

const device: DeviceSummary = {
  id: "dev-1",
  name: "gpu-box",
  connection: { kind: "ssh", machineId: "m1", remotePort: 18765 },
  createdAt: "",
  hasToken: true,
  targetLabel: "dev@gpu-box",
};

describe("openRemoteSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStatusStore.setState({ statusMap: new Map() });
  });

  it("registers the session, marks it live and adopts it as a reattaching tab", async () => {
    const tabId = await openRemoteSession(device, "remote-1", {
      projectPath: "/srv/api",
      projectName: "api",
      cliTool: "claude",
    });

    expect(attachDeviceSession).toHaveBeenCalledWith("dev-1", "remote-1");
    // 没有 live 标记，恢复路径会把它当死会话在本机新建（用的是对端路径）
    expect(useTerminalStatusStore.getState().statusMap.has("remote-1")).toBe(true);
    const tab = collectPanels(usePanesStore.getState().rootPane)
      .flatMap((panel) => panel.tabs)
      .find((item) => item.id === tabId);
    expect(tab?.title).toBe("gpu-box · api");
    const leaf = tab?.terminalRootPane;
    // 写成待重连的 savedSession，由恢复路径接到对端 PTY，而不是新建
    expect(leaf?.type === "leaf" ? leaf.savedSessionId : null).toBe("remote-1");
  });

  it("creates the session on the device before opening it", async () => {
    await startRemoteSession(device, { path: "/srv/web", name: "web" }, { name: "prod", path: "/srv" }, "codex");

    expect(createDeviceSession).toHaveBeenCalledWith("dev-1", expect.objectContaining({
      projectPath: "/srv/web",
      workspaceName: "prod",
      cliTool: "codex",
    }));
    expect(useTerminalStatusStore.getState().statusMap.has("remote-new")).toBe(true);
  });
});
