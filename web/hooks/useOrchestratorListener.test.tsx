import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { toastErr, toastInfo } from "@/lib/feedback";
import { useOrchestratorListener } from "./useOrchestratorListener";
import { useActivityBarStore, usePanesStore } from "@/stores";
import { createPanel, collectPanels } from "@/lib/paneTree";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";

type WebviewListener = (event: { payload: Record<string, unknown> }) => void | Promise<void>;

vi.mock("@/lib/feedback", () => ({
  toastErr: vi.fn(),
  toastInfo: vi.fn(),
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

type Listeners = Map<string, WebviewListener>;

const LAUNCH_EVENT = "orchestrator-launch-task";
const BASE_LAUNCH_PAYLOAD = {
  projectPath: "/tmp/project-a",
  projectId: "project-a",
  cliTool: "codex",
};

/** 挂上 hook 并等到指定事件的监听注册完成。 */
async function mountListener(eventName: string = LAUNCH_EVENT): Promise<Listeners> {
  const listeners = mockWebviewListeners();
  renderHook(() => useOrchestratorListener());
  await waitFor(() => expect(listeners.has(eventName)).toBe(true));
  return listeners;
}

async function fire(listeners: Listeners, eventName: string, payload: Record<string, unknown>) {
  await act(async () => {
    await listeners.get(eventName)?.({ payload });
  });
}

/** 挂 hook 并派发一次 launch-task；payload 叠加在 BASE_LAUNCH_PAYLOAD 上。 */
async function fireLaunch(payload: Record<string, unknown>) {
  const listeners = await mountListener();
  await fire(listeners, LAUNCH_EVENT, { ...BASE_LAUNCH_PAYLOAD, ...payload });
}

function seedCallerTab(sessionId: string) {
  const panes = usePanesStore.getState();
  panes.addTab(panes.rootPane.id, {
    projectId: "project-a",
    projectPath: "/tmp/project-a",
    sessionId,
    cliTool: "claude",
  });
}

function allTabs() {
  return usePanesStore.getState().allPanelsAcrossLayouts().flatMap((panel) => panel.tabs);
}

function bindCurrentLayoutTo(workspaceName: string) {
  usePanesStore.setState((state) => ({
    layouts: state.layouts.map((layout) =>
      layout.id === "layout-1" ? { ...layout, workspaceName } : layout,
    ),
  }));
}

describe("useOrchestratorListener layout placement", () => {
  beforeEach(() => {
    resetTauriInvoke();
    vi.mocked(toastErr).mockClear();
    vi.mocked(toastInfo).mockClear();
    vi.mocked(getCurrentWebview().listen).mockReset();
    mockTauriInvoke({
      exit_fullscreen: undefined,
      browser_close: undefined,
      stop_dsh_instance: true,
      respond_orchestrator_query: undefined,
    });
    resetStores();
  });

  it("launch-task 使用 layoutName 自动创建布局并把 tab 放入该布局（显式意图保留）", async () => {
    // 从 files 视图起步：显式 layoutName 仍要切过去并拽回 panes
    useActivityBarStore.setState({ appViewMode: "files" });
    await fireLaunch({ taskId: "task-1", sessionId: "session-1", layoutName: "MCP 自动任务" });

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
    const launchedTab = allTabs().find((tab) => tab.sessionId === "session-1");
    expect(launchedTab?.terminalRootPane).toMatchObject({
      type: "leaf",
    });

    // launchId **每次启动新生成**，绝不等于 projectId（docs/69 活体暗雷）：
    // 两者是不同概念，复用会让 launch id 跨启动绑死，而 bind_pty_session
    // 要求那行的 pty_session_id 满足 `IS NULL OR = 本次`——拿一个已被上次
    // PTY 占用的 id 去绑必然落空，resume id 永久丢失且不可自愈。
    const leaf = launchedTab?.terminalRootPane as { launchId?: string } | undefined;
    expect(leaf?.launchId).toMatch(/^launch-/);
    expect(leaf?.launchId).not.toBe("project-a");
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    // 已经切过去了，就不该再弹「已在某布局启动」的提示
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("重复 launch-task 事件不会创建第二个相同会话标签", async () => {
    const listeners = await mountListener();
    const payload = {
      ...BASE_LAUNCH_PAYLOAD,
      taskId: "task-duplicate",
      sessionId: "session-duplicate",
      tabId: "tab-duplicate",
      terminalPaneId: "terminal-pane-duplicate",
      cliTool: "opencode",
    };
    await fire(listeners, LAUNCH_EVENT, payload);
    await fire(listeners, LAUNCH_EVENT, payload);

    const tabs = allTabs().filter((tab) => tab.sessionId === "session-duplicate");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.id).toBe("tab-duplicate");
  });

  it("listen 尚未返回卸载函数时 effect 清理仍会移除全部监听", async () => {
    const pendingResolvers: Array<(unlisten: UnlistenFn) => void> = [];
    const unlisten = vi.fn();
    vi.mocked(getCurrentWebview().listen).mockImplementation(
      () => new Promise<UnlistenFn>((resolve) => pendingResolvers.push(resolve)),
    );

    const { unmount } = renderHook(() => useOrchestratorListener());
    await waitFor(() => expect(pendingResolvers).toHaveLength(8));

    unmount();
    pendingResolvers.forEach((resolve) => resolve(unlisten));

    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(8));
  });

  it("launch-task 把显式 launchProfileId 和 modelId 保存在前端 tab 元数据", async () => {
    await fireLaunch({
      taskId: "task-profile",
      sessionId: "session-profile",
      launchProfileId: "profile-yolo",
      launchCwd: "/tmp/worktree",
      workspacePath: "/tmp/workspace",
      modelId: "claude-sonnet-4-6",
      cliTool: "claude",
    });

    const tab = allTabs().find((item) => item.sessionId === "session-profile");
    expect(tab?.launchProfileId).toBe("profile-yolo");
    expect(tab?.modelId).toBe("claude-sonnet-4-6");
    expect(tab?.workspacePath).toBe("/tmp/workspace");
    expect(tab?.launchExtras?.launchCwd).toBe("/tmp/worktree");
    expect(tab?.terminalRootPane).toMatchObject({ launchExtras: { launchCwd: "/tmp/worktree" } });
  });

  it("launch-task 有调用者会话时默认在其 pane 旁边分屏打开(并排,不是后台标签)", async () => {
    seedCallerTab("caller-1");
    await fireLaunch({ taskId: "task-2", sessionId: "child-1", parentSessionId: "caller-1" });

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

  // open_terminal_tab 复用 launch-task 事件：cliTool=none + placement=tab，
  // 前端必须落成普通 shell 标签（与用户手开的「仅终端」一致），且原样采用出生锚点。
  it("open_terminal_tab 事件(cliTool=none, placement=tab)在调用者窗格落成普通 shell 标签", async () => {
    seedCallerTab("caller-1");
    await fireLaunch({
      taskId: "task-shell",
      sessionId: "shell-1",
      projectId: "orch-shell",
      launchCwd: "/tmp/project-a/sub",
      tabId: "tab-shell",
      terminalPaneId: "terminal-pane-shell",
      title: "ssh heze",
      cliTool: "none",
      providerSelection: "none",
      runtimeKind: "local",
      placement: "tab",
      parentSessionId: "caller-1",
    });

    const state = usePanesStore.getState();
    // tab 落位：不分屏，进调用者所在窗格。
    expect(state.rootPane.type).toBe("panel");
    const panel = collectPanels(state.rootPane)[0];
    expect(panel.tabs.some((t) => t.sessionId === "caller-1")).toBe(true);
    const shellTab = panel.tabs.find((t) => t.sessionId === "shell-1");
    expect(shellTab?.id).toBe("tab-shell");
    expect(shellTab?.title).toBe("ssh heze");
    expect(shellTab?.cliTool).toBe("none");
    expect(shellTab?.launchClaude).toBeFalsy();
    expect(shellTab?.launchExtras?.launchCwd).toBe("/tmp/project-a/sub");
    expect(shellTab?.terminalRootPane).toMatchObject({
      type: "leaf",
      id: "terminal-pane-shell",
      restoreMode: "shell",
      sessionId: "shell-1",
    });
    expect(panel.activeTabId).toBe("tab-shell");
  });

  // 落位规则（resolveWorkspaceLaunchLayout）：无父会话的外部/headless 调用才走
  // workspaceName 路由；当前布局未绑定时留在原地，绑了别的工作空间才自动跳。
  function seedBoundLayout(workspaceName: string) {
    const state = usePanesStore.getState();
    const otherPane = createPanel();
    usePanesStore.setState({
      layouts: [
        ...state.layouts,
        {
          id: "layout-bound",
          name: "已绑定布局",
          rootPane: otherPane,
          activePaneId: otherPane.id,
          workspaceName,
          lastActiveAt: Date.now(),
        },
      ],
    });
  }

  it("launch-task 无父会话且当前布局绑了其他工作空间时仍自动路由", async () => {
    seedBoundLayout("ws-a");
    bindCurrentLayoutTo("ws-other");
    await fireLaunch({ taskId: "task-route", sessionId: "session-route", workspaceName: "ws-a" });

    expect(usePanesStore.getState().currentLayoutId).toBe("layout-bound");
  });

  // 回归：自动路由是「当前布局绑着别的工作空间」这一狭窄前提下的落点推导，
  // 它不能凌驾于 silent 之上——silent 的契约是完全不打扰，连这种路由也不许切画面。
  it("launch-task placement=silent 时即使当前布局绑了其他工作空间也只落位不切布局", async () => {
    seedBoundLayout("ws-a");
    bindCurrentLayoutTo("ws-other");
    await fireLaunch({
      taskId: "task-route-silent",
      sessionId: "session-route-silent",
      workspaceName: "ws-a",
      placement: "silent",
    });

    const state = usePanesStore.getState();
    // 画面留在原处
    expect(state.currentLayoutId).toBe("layout-1");
    // 但会话仍然落进绑定布局，而不是塞到用户眼前这个别的工作空间的布局里
    expect(state.findTabBySessionAcrossLayouts("session-route-silent")?.layoutId).toBe(
      "layout-bound",
    );
  });

  // 回归：当前布局未绑定时 resolver 返回当前布局，不得置位自动路由意图，
  // 否则会退回「每次启动都跳布局」的老毛病。
  it("launch-task 当前布局未绑定时既不切布局也落在当前布局", async () => {
    seedBoundLayout("ws-a");
    await fireLaunch({ taskId: "task-stay-2", sessionId: "session-stay-2", workspaceName: "ws-a" });

    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe("layout-1");
    expect(state.findTabBySessionAcrossLayouts("session-stay-2")?.layoutId).toBe("layout-1");
  });

  it("launch-task 有父会话时不受 workspace 路由影响(leader/worker 同布局)", async () => {
    seedBoundLayout("ws-a");
    seedCallerTab("leader-1");
    await fireLaunch({
      taskId: "task-worker",
      sessionId: "worker-1",
      workspaceName: "ws-a",
      parentSessionId: "leader-1",
    });

    const state = usePanesStore.getState();
    // 父会话在 layout-1，即使 ws-a 绑定到 layout-bound 也不能跳走，否则 #N.M 编号失效。
    expect(state.currentLayoutId).toBe("layout-1");
    const panels = collectPanels(state.rootPane);
    expect(panels.some((p) => p.tabs.some((t) => t.sessionId === "worker-1"))).toBe(true);
  });

  it("launch-task 缺少 projectPath 时不创建布局和 tab", async () => {
    await fireLaunch({
      taskId: "task-blank-path",
      sessionId: "session-blank-path",
      projectPath: "",
      layoutName: "不应创建",
    });

    const state = usePanesStore.getState();
    expect(state.layouts).toHaveLength(1);
    expect(state.layouts.some((layout) => layout.name === "不应创建")).toBe(false);
    expect(useActivityBarStore.getState().appViewMode).toBe("home");
    expect(allTabs()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: "session-blank-path" })])
    );
    expect(toastErr).toHaveBeenCalledWith(expect.stringContaining("项目路径"));
  });

  it("leader 在别的布局时不抢当前布局，worker 仍建在 leader 那边并弹可跳转提示", async () => {
    // 布局 1 里放 leader，然后用户切到布局 2 干活
    seedCallerTab("leader-1");
    const secondLayoutId = usePanesStore.getState().createLayout("布局 2");
    usePanesStore.getState().switchLayout(secondLayoutId);
    useActivityBarStore.setState({ appViewMode: "files" });

    await fireLaunch({ taskId: "task-follow", sessionId: "worker-1", parentSessionId: "leader-1" });

    const state = usePanesStore.getState();
    // 用户没被弹回布局 1，也没被从 files 视图拽出来
    expect(state.currentLayoutId).toBe(secondLayoutId);
    expect(useActivityBarStore.getState().appViewMode).toBe("files");
    // worker 确实建在 leader 所在的布局 1，而不是插进用户正在看的布局 2
    const worker = state.findTabBySessionAcrossLayouts("worker-1");
    expect(worker?.layoutId).toBe("layout-1");
    expect(collectPanels(state.rootPane).flatMap((p) => p.tabs)).toHaveLength(1);
    // 给了一条可点击跳转的提示
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("布局 1"),
      expect.objectContaining({ action: expect.objectContaining({ onClick: expect.any(Function) }) }),
    );
  });

  it("placement=silent 既不切布局也不切视图、不弹提示", async () => {
    seedCallerTab("leader-2");
    const secondLayoutId = usePanesStore.getState().createLayout("布局 2");
    usePanesStore.getState().switchLayout(secondLayoutId);
    useActivityBarStore.setState({ appViewMode: "files" });

    await fireLaunch({
      taskId: "task-silent",
      sessionId: "worker-silent",
      parentSessionId: "leader-2",
      placement: "silent",
    });

    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe(secondLayoutId);
    expect(useActivityBarStore.getState().appViewMode).toBe("files");
    expect(state.findTabBySessionAcrossLayouts("worker-silent")?.layoutId).toBe("layout-1");
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("query-panes 返回当前 panes 兼容字段和 layouts 详情", async () => {
    const secondLayoutId = usePanesStore.getState().createLayout("第二布局");
    usePanesStore.getState().switchLayout("layout-1");
    const listeners = await mountListener("orchestrator-query-panes");
    await fire(listeners, "orchestrator-query-panes", { requestId: "query-1" });

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
    const listeners = await mountListener("orchestrator-open-browser-tab");
    await fire(listeners, "orchestrator-open-browser-tab", {
      requestId: "browser-request-1",
      tabId: "browser-tab-1",
      url: "http://localhost:5173/",
      title: "Local preview",
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
    expect(invoke).toHaveBeenCalledWith("respond_orchestrator_query", {
      requestId: "browser-request-1",
      data: JSON.stringify({ tabId: "browser-tab-1" }),
    });
  });

  it("closes an inactive layout's browser through lifecycle without switching or closing another tab", async () => {
    const secondPane = createPanel();
    usePanesStore.setState((state) => ({ layouts: [...state.layouts,
      { id: "layout-2", name: "Second", rootPane: secondPane, activePaneId: secondPane.id }] }));
    usePanesStore.getState().openBrowser("https://example.test/", "Remote layout", "browser-close", { layoutId: "layout-2" });
    usePanesStore.getState().openBrowser("https://keep.test/", "Keep", "browser-keep");
    const listeners = await mountListener("orchestrator-close-browser-tab");
    await fire(listeners, "orchestrator-close-browser-tab", { tabId: "browser-close" });
    const state = usePanesStore.getState();
    expect(state.findTabAcrossLayouts("browser-close")).toBeNull();
    expect(state.findTabAcrossLayouts("browser-keep")).not.toBeNull();
    expect(state.currentLayoutId).toBe("layout-1");
    expect(state.closedTabs).toHaveLength(0);
    expect(invoke).toHaveBeenCalledWith("browser_close", { tabId: "browser-close" });
  });

  it("closes DSH through lifecycle, including its managed process, and ignores wrong types", async () => {
    const dshId = usePanesStore.getState().openDsh("/repo");
    const paneId = usePanesStore.getState().activePaneId;
    usePanesStore.getState().addTab(paneId, { projectId: "p", projectPath: "/repo", tabId: "terminal-keep", sessionId: "live" });
    const listeners = await mountListener("orchestrator-close-browser-tab");
    await fire(listeners, "orchestrator-close-browser-tab", { tabId: "terminal-keep" });
    await fire(listeners, "orchestrator-close-browser-tab", { tabId: dshId });
    await fire(listeners, "orchestrator-close-browser-tab", { tabId: dshId });
    expect(usePanesStore.getState().findTabAcrossLayouts("terminal-keep")).not.toBeNull();
    expect(usePanesStore.getState().findTabAcrossLayouts(dshId!)).toBeNull();
    expect(invoke).toHaveBeenCalledWith("stop_dsh_instance", { tabId: dshId });
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "stop_dsh_instance")).toHaveLength(1);
  });

  it("refuses a browser identity shared by a different tab type in another layout", async () => {
    usePanesStore.getState().openBrowser("https://example.test/", "Browser", "shared-id");
    const secondPane = createPanel();
    secondPane.tabs = [{ id: "shared-id", title: "Terminal", contentType: "terminal", projectId: "p", projectPath: "/repo", sessionId: "live" }];
    usePanesStore.setState((state) => ({ layouts: [...state.layouts,
      { id: "layout-2", name: "Second", rootPane: secondPane, activePaneId: secondPane.id }] }));
    const listeners = await mountListener("orchestrator-close-browser-tab");
    await fire(listeners, "orchestrator-close-browser-tab", { tabId: "shared-id" });
    expect(allTabs().filter((tab) => tab.id === "shared-id")).toHaveLength(2);
  });

  it("open-browser-tab 复用时应答已有 tabId", async () => {
    usePanesStore.getState().openBrowser("http://localhost:5173/", "Existing", "existing-tab");
    const listeners = await mountListener("orchestrator-open-browser-tab");
    await fire(listeners, "orchestrator-open-browser-tab", {
      requestId: "browser-request-2",
      tabId: "unused-new-id",
      url: "http://localhost:5173/",
      reuse: true,
    });

    expect(invoke).toHaveBeenCalledWith("respond_orchestrator_query", {
      requestId: "browser-request-2",
      data: JSON.stringify({ tabId: "existing-tab" }),
    });
  });

  // 「谁指挥的就开到谁那儿」：调用方在别的布局时，标签必须落在它那边，
  // 不能飞到用户此刻正看着的布局，也不能把用户拽走。
  it.each([
    {
      eventName: "orchestrator-open-browser-tab",
      payload: {
        requestId: "browser-request-3",
        tabId: "browser-tab-3",
        url: "http://localhost:5173/from-caller",
        callerSessionId: "caller-session",
      },
      tabKey: (tab: { id: string }) => tab.id,
      expected: "browser-tab-3",
    },
    {
      eventName: "orchestrator-open-file",
      payload: {
        filePath: "/tmp/project-b/main.rs",
        projectPath: "/tmp/project-b",
        title: "main.rs",
        callerSessionId: "caller-session",
      },
      tabKey: (tab: { filePath?: string }) => tab.filePath,
      expected: "/tmp/project-b/main.rs",
    },
  ])("$eventName 落到调用方所在布局，不切走当前布局", async ({ eventName, payload, tabKey, expected }) => {
    const secondPane = createPanel();
    usePanesStore.setState((state) => ({
      layouts: [
        ...state.layouts,
        { id: "layout-2", name: "第二布局", rootPane: secondPane, activePaneId: secondPane.id },
      ],
    }));
    // 调用方会话住在 layout-2
    usePanesStore.getState().addTab(
      secondPane.id,
      { projectId: "p", projectPath: "/tmp/project-b", sessionId: "caller-session" },
      "layout-2",
    );

    const listeners = await mountListener(eventName);
    await fire(listeners, eventName, payload);

    const state = usePanesStore.getState();
    expect(state.currentLayoutId).toBe("layout-1");
    const layout2 = state.layouts.find((item) => item.id === "layout-2")!;
    expect(collectPanels(layout2.rootPane).flatMap((pane) => pane.tabs).map(tabKey)).toContain(expected);
    expect(collectPanels(state.rootPane).flatMap((pane) => pane.tabs).map(tabKey)).not.toContain(expected);
    // 落点不在眼前：给一条可点提示，而不是自动切过去
    expect(toastInfo).toHaveBeenCalled();
  });
});
