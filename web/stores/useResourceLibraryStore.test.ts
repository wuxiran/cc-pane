import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityBarStore } from "./useActivityBarStore";
import { openResourceLibrary, useResourceLibraryStore } from "./useResourceLibraryStore";

const bridge = vi.hoisted(() => ({ settingsWindow: false, send: vi.fn(() => Promise.resolve()) }));
vi.mock("@/services/settingsWindowService", () => ({
  isSettingsWindow: () => bridge.settingsWindow,
  sendActionToMainWindow: bridge.send,
}));

describe("openResourceLibrary", () => {
  beforeEach(() => {
    bridge.settingsWindow = false;
    bridge.send.mockClear();
    useResourceLibraryStore.setState({ section: "mcp", scope: null });
    useActivityBarStore.setState({ appViewMode: "panes", activeView: "explorer", sidebarVisible: false });
  });

  it("切到资源库、展开侧栏并设置作用域", () => {
    openResourceLibrary("mcp", { workspaceName: "w" });
    expect(useActivityBarStore.getState().appViewMode).toBe("resources");
    expect(useActivityBarStore.getState().sidebarVisible).toBe(true);
    expect(useResourceLibraryStore.getState().scope).toEqual({ workspaceName: "w" });
  });

  it("已经在资源库时不会被切回分屏", () => {
    openResourceLibrary("mcp");
    openResourceLibrary("mcp");
    expect(useActivityBarStore.getState().appViewMode).toBe("resources");
  });

  it("不传作用域时保留当前选择", () => {
    useResourceLibraryStore.setState({ scope: { projectPath: "/p" } });
    openResourceLibrary("mcp");
    expect(useResourceLibraryStore.getState().scope).toEqual({ projectPath: "/p" });
  });

  it("设置窗口里转发到主窗口，不改本窗口状态", () => {
    bridge.settingsWindow = true;
    openResourceLibrary("mcp", { projectPath: "/p" });
    expect(bridge.send).toHaveBeenCalledWith({ type: "openResourceLibrary", section: "mcp", scope: { projectPath: "/p" } });
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
  });
});
