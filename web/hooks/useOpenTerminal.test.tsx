import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { usePanesStore } from "@/stores";
import { createPanel } from "@/stores/paneTreeHelpers";
import { historyService, localHistoryService } from "@/services";
import { useOpenTerminal } from "./useOpenTerminal";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

describe("useOpenTerminal host path guard", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks a Windows local path before creating a tab on a non-Windows host", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const openProject = vi.fn();
    usePanesStore.setState({ openProject } as never);
    const { result } = renderHook(() => useOpenTerminal());

    act(() => result.current({ path: "D:\\repo", cliTool: "codex" }));

    expect(openProject).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("D:\\repo"));
  });

  it("新建未绑定布局后打开工作空间时留在当前布局", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
    vi.spyOn(historyService, "add").mockResolvedValue(1);
    vi.spyOn(localHistoryService, "initProjectHistory").mockResolvedValue(undefined);
    const openProject = vi.fn();
    const previousRoot = createPanel();
    const currentRoot = createPanel();
    const layouts = [
      {
        id: "layout-previous",
        name: "之前布局",
        kind: "normal" as const,
        workspaceName: "Trust",
        rootPane: previousRoot,
        activePaneId: previousRoot.id,
      },
      {
        id: "layout-new",
        name: "新布局",
        kind: "normal" as const,
        rootPane: currentRoot,
        activePaneId: currentRoot.id,
      },
    ];
    usePanesStore.setState({
      openProject,
      layouts,
      currentLayoutId: "layout-new",
      rootPane: currentRoot,
      activePaneId: currentRoot.id,
      listLayouts: () => layouts,
    } as never);
    const { result } = renderHook(() => useOpenTerminal());

    act(() => result.current({
      path: "/tmp/trust",
      workspaceName: "Trust",
      cliTool: "none",
    }));

    expect(openProject).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: "/tmp/trust",
      targetLayoutId: "layout-new",
    }));
  });

  it("当前布局已绑定其他工作空间时仍路由到匹配布局", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
    vi.spyOn(historyService, "add").mockResolvedValue(1);
    vi.spyOn(localHistoryService, "initProjectHistory").mockResolvedValue(undefined);
    const openProject = vi.fn();
    const targetRoot = createPanel();
    const currentRoot = createPanel();
    const layouts = [
      {
        id: "layout-trust",
        name: "Trust 布局",
        kind: "normal" as const,
        workspaceName: "Trust",
        rootPane: targetRoot,
        activePaneId: targetRoot.id,
      },
      {
        id: "layout-other",
        name: "其他布局",
        kind: "normal" as const,
        workspaceName: "Other",
        rootPane: currentRoot,
        activePaneId: currentRoot.id,
      },
    ];
    usePanesStore.setState({
      openProject,
      layouts,
      currentLayoutId: "layout-other",
      rootPane: currentRoot,
      activePaneId: currentRoot.id,
      listLayouts: () => layouts,
    } as never);
    const { result } = renderHook(() => useOpenTerminal());

    act(() => result.current({
      path: "/tmp/trust",
      workspaceName: "Trust",
      cliTool: "none",
    }));

    expect(openProject).toHaveBeenCalledWith(expect.objectContaining({
      targetLayoutId: "layout-trust",
    }));
  });
});
