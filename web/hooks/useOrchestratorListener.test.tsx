import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useOrchestratorListener } from "./useOrchestratorListener";
import { useActivityBarStore, usePanesStore } from "@/stores";
import { createPanel, collectPanels } from "@/stores/paneTreeHelpers";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";

type WebviewListener = (event: { payload: Record<string, unknown> }) => void | Promise<void>;

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

function resetStores() {
  const rootPane = createPanel();
  usePanesStore.setState({
    rootPane,
    activePaneId: rootPane.id,
    layouts: [{
      id: "layout-1",
      name: "布局 1",
      rootPane,
      activePaneId: rootPane.id,
    }],
    currentLayoutId: "layout-1",
    closedTabs: [],
    poppedOutTabs: new Set<string>(),
  });
  useActivityBarStore.setState({
    activeView: "explorer",
    sidebarVisible: true,
    appViewMode: "home",
    orchestrationOverlayOpen: false,
  });
}

function mockWebviewListeners() {
  const listeners = new Map<string, WebviewListener>();
  vi.mocked(getCurrentWebview().listen).mockImplementation(async (eventName, handler) => {
    listeners.set(eventName, handler as WebviewListener);
    return () => listeners.delete(eventName);
  });
  return listeners;
}

describe("useOrchestratorListener layout placement", () => {
  beforeEach(() => {
    resetTauriInvoke();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    vi.mocked(getCurrentWebview().listen).mockReset();
    mockTauriInvoke({
      exit_fullscreen: undefined,
      respond_orchestrator_query: undefined,
    });
    resetStores();
  });

  it("launch-task 使用 layoutName 自动创建布局并把 tab 放入该布局", async () => {
    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorListener());
    await waitFor(() => expect(listeners.has("orchestrator-launch-task")).toBe(true));

    await act(async () => {
      await listeners.get("orchestrator-launch-task")?.({
        payload: {
          taskId: "task-1",
          sessionId: "session-1",
          projectPath: "/tmp/project-a",
          projectId: "project-a",
          layoutName: "MCP 自动任务",
          cliTool: "codex",
        },
      });
    });

    const state = usePanesStore.getState();
    const layout = state.layouts.find((item) => item.name === "MCP 自动任务");
    expect(layout).toBeTruthy();
    expect(state.currentLayoutId).toBe(layout?.id);
    expect(state.rootPane.type).toBe("panel");
    if (state.rootPane.type === "panel") {
      expect(state.rootPane.tabs.some((tab) => tab.sessionId === "session-1")).toBe(true);
    }
    const projectedLayout = state.listLayouts().find((item) => item.id === layout?.id);
    expect(projectedLayout?.rootPane).toBe(state.rootPane);
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
  });

  it("launch-task 把显式 launchProfileId 保存在前端 tab 元数据", async () => {
    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorListener());
    await waitFor(() => expect(listeners.has("orchestrator-launch-task")).toBe(true));

    await act(async () => {
      await listeners.get("orchestrator-launch-task")?.({
        payload: {
          taskId: "task-profile",
          sessionId: "session-profile",
          projectPath: "/tmp/project-a",
          projectId: "project-a",
          launchProfileId: "profile-yolo",
          cliTool: "claude",
        },
      });
    });

    const tab = usePanesStore
      .getState()
      .allPanelsAcrossLayouts()
      .flatMap((panel) => panel.tabs)
      .find((item) => item.sessionId === "session-profile");
    expect(tab?.launchProfileId).toBe("profile-yolo");
  });

  it("launch-task 有调用者会话时默认在其 pane 旁边分屏打开(并排,不是后台标签)", async () => {
    const panes = usePanesStore.getState();
    panes.addTab(panes.rootPane.id, {
      projectId: "project-a",
      projectPath: "/tmp/project-a",
      sessionId: "caller-1",
      cliTool: "claude",
    });

    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorListener());
    await waitFor(() => expect(listeners.has("orchestrator-launch-task")).toBe(true));

    await act(async () => {
      await listeners.get("orchestrator-launch-task")?.({
        payload: {
          taskId: "task-2",
          sessionId: "child-1",
          projectPath: "/tmp/project-a",
          projectId: "project-a",
          cliTool: "codex",
          parentSessionId: "caller-1",
        },
      });
    });

    const state = usePanesStore.getState();
    // 调用者 pane 旁边分屏 → rootPane 变 split，调用者与新会话各占一个窗格。
    expect(state.rootPane.type).toBe("split");
    const panels = collectPanels(state.rootPane);
    const callerPanel = panels.find((p) => p.tabs.some((t) => t.sessionId === "caller-1"));
    const childPanel = panels.find((p) => p.tabs.some((t) => t.sessionId === "child-1"));
    expect(callerPanel).toBeTruthy();
    expect(childPanel).toBeTruthy();
    // 分属不同窗格（并排），且焦点在新会话所在窗格。
    expect(callerPanel!.id).not.toBe(childPanel!.id);
    expect(state.activePaneId).toBe(childPanel!.id);
  });

  it("launch-task placement=tab 时塞进调用者 pane 的标签页(不分屏)", async () => {
    const panes = usePanesStore.getState();
    panes.addTab(panes.rootPane.id, {
      projectId: "project-a",
      projectPath: "/tmp/project-a",
      sessionId: "caller-1",
      cliTool: "claude",
    });

    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorListener());
    await waitFor(() => expect(listeners.has("orchestrator-launch-task")).toBe(true));

    await act(async () => {
      await listeners.get("orchestrator-launch-task")?.({
        payload: {
          taskId: "task-3",
          sessionId: "child-2",
          projectPath: "/tmp/project-a",
          projectId: "project-a",
          cliTool: "codex",
          parentSessionId: "caller-1",
          placement: "tab",
        },
      });
    });

    const state = usePanesStore.getState();
    // 显式 tab → 不分屏，新会话与调用者同 pane。
    expect(state.rootPane.type).toBe("panel");
    if (state.rootPane.type === "panel") {
      const sids = state.rootPane.tabs.map((t) => t.sessionId);
      expect(sids).toContain("caller-1");
      expect(sids).toContain("child-2");
    }
  });

  it("launch-task 缺少 projectPath 时不创建布局和 tab", async () => {
    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorListener());
    await waitFor(() => expect(listeners.has("orchestrator-launch-task")).toBe(true));

    await act(async () => {
      await listeners.get("orchestrator-launch-task")?.({
        payload: {
          taskId: "task-blank-path",
          sessionId: "session-blank-path",
          projectPath: "",
          projectId: "project-a",
          layoutName: "不应创建",
          cliTool: "codex",
        },
      });
    });

    const state = usePanesStore.getState();
    expect(state.layouts).toHaveLength(1);
    expect(state.layouts.some((layout) => layout.name === "不应创建")).toBe(false);
    expect(useActivityBarStore.getState().appViewMode).toBe("home");
    expect(state.allPanelsAcrossLayouts().flatMap((panel) => panel.tabs)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: "session-blank-path" })])
    );
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("项目路径"));
  });

  it("query-panes 返回当前 panes 兼容字段和 layouts 详情", async () => {
    const listeners = mockWebviewListeners();
    const secondLayoutId = usePanesStore.getState().createLayout("第二布局");
    usePanesStore.getState().switchLayout("layout-1");
    renderHook(() => useOrchestratorListener());
    await waitFor(() => expect(listeners.has("orchestrator-query-panes")).toBe(true));

    await act(async () => {
      await listeners.get("orchestrator-query-panes")?.({
        payload: {
          requestId: "query-1",
        },
      });
    });

    expect(invoke).toHaveBeenCalledWith(
      "respond_orchestrator_query",
      expect.objectContaining({ requestId: "query-1" }),
    );
    const calls = vi.mocked(invoke).mock.calls;
    const [, args] = calls[calls.length - 1]!;
    const data = JSON.parse((args as { data: string }).data) as {
      panes: Array<{ layoutId: string }>;
      layouts: Array<{ id: string; name: string; panes: Array<{ layoutId: string }> }>;
      currentLayoutId: string;
      layoutCount: number;
    };

    expect(data.currentLayoutId).toBe("layout-1");
    expect(data.panes.every((pane) => pane.layoutId === "layout-1")).toBe(true);
    expect(data.layouts.map((layout) => layout.id)).toContain(secondLayoutId);
    expect(data.layouts.find((layout) => layout.id === secondLayoutId)?.name).toBe("第二布局");
    expect(data.layoutCount).toBe(2);
  });

  it("open-browser-tab 事件切回 panes 并打开 browser tab", async () => {
    const listeners = mockWebviewListeners();
    renderHook(() => useOrchestratorListener());
    await waitFor(() => expect(listeners.has("orchestrator-open-browser-tab")).toBe(true));

    await act(async () => {
      await listeners.get("orchestrator-open-browser-tab")?.({
        payload: {
          tabId: "browser-tab-1",
          url: "http://localhost:5173/",
          title: "Local preview",
        },
      });
    });

    const browserTab = usePanesStore.getState().activePane()?.tabs.find(
      (tab) => tab.contentType === "browser",
    );
    expect(browserTab).toMatchObject({
      id: "browser-tab-1",
      browserUrl: "http://localhost:5173/",
      title: "Local preview",
    });
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
  });
});
