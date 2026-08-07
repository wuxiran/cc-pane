import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_LAYOUT_CHANGED_EVENT,
  usePanesStore,
  useSettingsStore,
  useTerminalStatusStore,
  useTerminalPathLinkStore,
  useWallpaperStore,
} from "@/stores";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import { historyService, sessionRestoreService, terminalService } from "@/services";
import { getRecoverySnapshot as getRecoverySnapshotFn } from "@/services/terminalRecovery";
import { createTerminalRendererController } from "./terminalRendererController";
import { createTerminalLayoutScheduler } from "./terminalLayoutScheduler";
import { TERMINAL_FIT_ALL_EVENT } from "./terminalFitEvents";
import { terminalRestoreLaunchQueue } from "./terminalRestoreQueue";
import TerminalView from "./TerminalView";
import { attachTerminalImeGuard } from "./terminalImeGuard";

/* ------------------------------------------------------------------ */
/* xterm mock                                                          */
/* ------------------------------------------------------------------ */

const MockXterm = vi.hoisted(() => class MockXterm {
  static instances: MockXterm[] = [];

  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  element: HTMLElement | null = null;
  textarea: HTMLTextAreaElement | null = null;
  buffer = {
    active: {
      type: "normal",
      cursorX: 0,
      cursorY: 0,
      length: 2,
      getLine: (y: number) => ({ translateToString: () => `line-${y}` }),
    },
  };
  unicode = { activeVersion: "6" };
  parser = {
    registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
    registerOscHandler: vi.fn((
      _ident: number,
      _handler: (data: string) => boolean,
    ) => ({ dispose: vi.fn() })),
  };
  writtenLines: string[] = [];
  writtenData: string[] = [];
  writeEvents: string[] = [];
  dataHandler: ((data: string) => void) | null = null;
  keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
  linkProvider: unknown = null;
  linkProviderDisposable = { dispose: vi.fn() };
  disposed = false;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    MockXterm.instances.push(this);
  }

  loadAddon = vi.fn();

  open(host: HTMLElement) {
    this.element = document.createElement("div");
    this.textarea = document.createElement("textarea");
    this.element.appendChild(this.textarea);
    host.appendChild(this.element);
  }

  write(data: string, callback?: () => void) {
    this.writtenData.push(data);
    this.writeEvents.push(data);
    callback?.();
  }

  writeln(line: string) {
    this.writtenLines.push(line);
    this.writeEvents.push(line);
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
    return { dispose: vi.fn() };
  }

  registerLinkProvider = vi.fn((provider: unknown) => {
    this.linkProvider = provider;
    return this.linkProviderDisposable;
  });

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyEventHandler = handler;
  }

  focus = vi.fn();
  paste = vi.fn();
  refresh = vi.fn();
  getSelection = vi.fn(() => "");
  clearSelection = vi.fn();
  selectAll = vi.fn();
  clear = vi.fn();

  reset() {
    // 语义忠实：reset 丢弃现有画面（含 scrollback），resync 快照重建靠它
    this.writtenData = [];
    this.writtenLines = [];
    this.writeEvents.push("<reset>");
  }

  dispose() {
    this.disposed = true;
  }
});
type MockXterm = InstanceType<typeof MockXterm>;

vi.mock("@xterm/xterm", () => ({
  Terminal: MockXterm,
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
    dispose = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {},
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

/* ------------------------------------------------------------------ */
/* heavy collaborator mocks                                            */
/* ------------------------------------------------------------------ */

vi.mock("./terminalRendererController", () => ({
  createTerminalRendererController: vi.fn(() => ({
    configure: vi.fn(),
    dispose: vi.fn(),
    getActiveRenderer: vi.fn(() => "canvas"),
    clearTextureAtlas: vi.fn(),
    repaint: vi.fn(),
  })),
}));

vi.mock("./terminalLayoutScheduler", () => ({
  createTerminalLayoutScheduler: vi.fn(() => ({
    schedule: vi.fn(),
    flush: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("./terminalRenderer", () => ({
  resolveTerminalRendererModeForSession: vi.fn(() => "canvas"),
  setTerminalTransparencyProvider: vi.fn(),
}));

vi.mock("./terminalInputTrace", () => ({
  attachTerminalInputTrace: vi.fn(() => ({ dispose: vi.fn(), onData: vi.fn() })),
  summarizeTerminalInputData: vi.fn((data: unknown) => String(data)),
}));

vi.mock("./terminalDomInputFallback", () => ({
  attachTerminalDomInputFallback: vi.fn(() => ({ dispose: vi.fn(), recordXtermData: vi.fn() })),
}));

vi.mock("./terminalImeGuard", () => ({
  attachTerminalImeGuard: vi.fn(() => ({
    dispose: vi.fn(),
    clearNativeEditState: vi.fn(),
    handleKeyEvent: vi.fn(() => true),
  })),
  isLinuxWebKitImeEnvironment: vi.fn(() => false),
}));

vi.mock("./terminalClipboard", async () => {
  const actual = await vi.importActual<typeof import("./terminalClipboard")>("./terminalClipboard");
  return {
    ...actual,
    resolveTerminalPastePayload: vi.fn().mockResolvedValue({
      kind: "text",
      text: "pasted text",
    }),
  };
});

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/terminalRestoreBarrier", () => ({
  waitForTerminalRestoreBarrier: vi.fn().mockResolvedValue(undefined),
  waitForTerminalRestoreBarrierWithDeadline: vi.fn().mockResolvedValue(undefined),
}));

/* ------------------------------------------------------------------ */
/* service mocks                                                       */
/* ------------------------------------------------------------------ */

vi.mock("@/services/terminalService", () => ({
  killedSessions: new Set<string>(),
  ensureListeners: vi.fn().mockResolvedValue(undefined),
  terminalService: {
    getWindowsBuildNumber: vi.fn().mockResolvedValue(0),
    createSession: vi.fn(),
    registerOutput: vi.fn().mockResolvedValue(undefined),
    registerExit: vi.fn().mockResolvedValue(undefined),
    registerDesync: vi.fn().mockResolvedValue(undefined),
    detachOutput: vi.fn(),
    detachExit: vi.fn(),
    resize: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    releaseSession: vi.fn().mockResolvedValue(undefined),
    getReplaySnapshot: vi.fn().mockResolvedValue(null),
    getAllStatus: vi.fn().mockResolvedValue([]),
  },
}));

// 恢复读路径单入口（M3b-3）：TerminalView 与 terminalSessionBinding 都直连
// 该模块（不经桶文件），必须 mock 直接模块而非桶（既往教训：mock 桶会被绕过）。
vi.mock("@/services/terminalRecovery", () => ({
  getRecoverySnapshot: vi.fn().mockResolvedValue(null),
  _resetRecoveryCapabilityForTest: vi.fn(),
}));

vi.mock("@/services/historyService", () => ({
  historyService: {
    startLaunchHistoryBackfill: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/sessionRestoreService", () => ({
  sessionRestoreService: {
    loadOutput: vi.fn().mockResolvedValue([]),
    clearOutput: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/terminalPathLinkService", () => ({
  terminalPathLinkService: {
    resolve: vi.fn(),
    runDesktopAction: vi.fn(),
    openExternalUrl: vi.fn().mockResolvedValue(undefined),
  },
}));

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const createSession = vi.mocked(terminalService.createSession);
const registerOutput = vi.mocked(terminalService.registerOutput);
const registerExit = vi.mocked(terminalService.registerExit);
const resize = vi.mocked(terminalService.resize);
const writeToSession = vi.mocked(terminalService.write);
const getRecoverySnapshot = vi.mocked(getRecoverySnapshotFn);
const startLaunchHistoryBackfill = vi.mocked(historyService.startLaunchHistoryBackfill);
const loadOutput = vi.mocked(sessionRestoreService.loadOutput);
const killSession = vi.mocked(terminalService.killSession);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderTerminalView(props?: Partial<React.ComponentProps<typeof TerminalView>>) {
  return render(
    <TerminalView
      sessionId={null}
      launchId="reserved-launch"
      projectPath="/tmp/proj"
      visibilityOwnerId="tab-1"
      paneId="pane-1"
      tabId="tab-1"
      onSessionCreated={vi.fn()}
      {...props}
    />
  );
}

async function lastTerm(): Promise<MockXterm> {
  await waitFor(() => expect(MockXterm.instances.length).toBeGreaterThan(0));
  return MockXterm.instances[MockXterm.instances.length - 1];
}

describe("TerminalView", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    MockXterm.instances = [];
    createSession.mockResolvedValue("new-session-1" as never);
    usePanesStore.setState({
      canCreateTerminalSession: () => true,
      updateTerminalLaunchId: vi.fn(),
    } as never);
    useSettingsStore.setState({ settings: undefined } as never);
    useTerminalStatusStore.setState({ statusMap: new Map() } as never);
    useWallpaperStore.setState({ resolved: null, assetUrl: null });
    // 可见性单源：默认把 scaffold 的 owner 置为前台焦点视图
    useTabViewStateStore.setState({ views: {}, aggregate: {} });
    useTabViewStateStore.getState().reportView("tab-1", "primary", "active");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("creates a backend session sized to the terminal and reports it", async () => {
    const onSessionCreated = vi.fn();
    renderTerminalView({ onSessionCreated, cliTool: "none", launchId: "reserved-launch" });

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        launchId: "reserved-launch",
        projectPath: "/tmp/proj",
        cols: 80,
        rows: 24,
        cliTool: "none",
      })
    );
    const createdLaunchId = createSession.mock.calls[0][0]?.launchId;
    expect(createdLaunchId).toBe("reserved-launch");
    expect(usePanesStore.getState().updateTerminalLaunchId).toHaveBeenCalledWith(
      "tab-1",
      "pane-1",
      createdLaunchId,
    );

    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith("new-session-1"));
    expect(registerOutput).toHaveBeenCalledWith("new-session-1", expect.any(Function));
    expect(registerExit).toHaveBeenCalledWith("new-session-1", expect.any(Function));
    // 新建会话不回放快照
    expect(getRecoverySnapshot).not.toHaveBeenCalled();
  });

  it("registers one local path provider and disposes it on unmount", async () => {
    const view = renderTerminalView();
    const term = await lastTerm();

    expect(term.registerLinkProvider).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(term.linkProviderDisposable.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not register a local path provider for SSH terminals", async () => {
    renderTerminalView({ ssh: { host: "example.com", username: "dev" } as never });
    const term = await lastTerm();

    expect(term.registerLinkProvider).not.toHaveBeenCalled();
  });

  it("routes OSC 8 file links through the current live session", async () => {
    const open = vi.spyOn(useTerminalPathLinkStore.getState(), "open").mockResolvedValue();
    renderTerminalView({ sessionId: "existing-1" });
    const term = await lastTerm();
    await waitFor(() => expect(registerOutput).toHaveBeenCalledWith("existing-1", expect.any(Function)));

    const linkHandler = term.options.linkHandler as {
      activate: (event: MouseEvent, uri: string) => void;
    };
    linkHandler.activate({} as MouseEvent, "file:///tmp/proj/src/App.tsx:12:8");

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/proj/src/App.tsx", line: 12, column: 8 }),
      "existing-1",
    );
  });

  it("applies the terminal path link setting without recreating xterm", async () => {
    useSettingsStore.setState({
      settings: { terminal: { pathLinksEnabled: false } },
    } as never);
    const open = vi.spyOn(useTerminalPathLinkStore.getState(), "open").mockResolvedValue();
    renderTerminalView({ sessionId: "existing-1" });
    const term = await lastTerm();
    const linkHandler = term.options.linkHandler as {
      activate: (event: MouseEvent, uri: string) => void;
    };

    linkHandler.activate({} as MouseEvent, "file:///tmp/proj/src/App.tsx");
    expect(open).not.toHaveBeenCalled();

    useSettingsStore.setState({
      settings: { terminal: { pathLinksEnabled: true } },
    } as never);
    linkHandler.activate({} as MouseEvent, "file:///tmp/proj/src/App.tsx");

    expect(open).toHaveBeenCalledTimes(1);
    expect(MockXterm.instances).toHaveLength(1);
  });

  it("backfills launch history for CLI sessions without a resume id", async () => {
    renderTerminalView({ cliTool: "claude" });

    await waitFor(() => expect(startLaunchHistoryBackfill).toHaveBeenCalled());
    const call = startLaunchHistoryBackfill.mock.calls[0];
    expect(call[0]).toBe(createSession.mock.calls[0][0]?.launchId);
    expect(call[1]).toBe("new-session-1");
    expect(call[2]).toBe("claude");
    expect(call[3]).toBe("local");
  });

  // 回归防线：曾经这里有个 `if (!effectiveResumeId)` 把带 resumeId 的会话挡在 backfill 外。
  // 恢复路径也必须为本次 PTY 的 one-shot launch id 补齐 history 行；挡掉之后
  // 恢复出来的会话下次重启仍会丢 resumeId。不要把这个条件加回来。
  it("backfills launch history for resumed sessions too", async () => {
    renderTerminalView({ cliTool: "claude", resumeId: "resume-abc" });

    await waitFor(() => expect(startLaunchHistoryBackfill).toHaveBeenCalled());
    const call = startLaunchHistoryBackfill.mock.calls[0];
    expect(call[0]).toBe(createSession.mock.calls[0][0]?.launchId);
    expect(call[2]).toBe("claude");
  });

  it("rotates the persisted launchId before a restored PTY is created", async () => {
    renderTerminalView({
      cliTool: "claude",
      restoring: true,
      savedSessionId: "expired-session",
      resumeId: "resume-abc",
      launchId: "previous-launch",
    });

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const createdLaunchId = createSession.mock.calls[0][0]?.launchId;
    expect(createdLaunchId).toMatch(/^launch-/);
    expect(createdLaunchId).not.toBe("previous-launch");
    expect(usePanesStore.getState().updateTerminalLaunchId).toHaveBeenCalledWith(
      "tab-1",
      "pane-1",
      createdLaunchId,
    );
  });

  it("skips history backfill for plain shells", async () => {
    renderTerminalView({ cliTool: "none" });

    await waitFor(() => expect(createSession).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startLaunchHistoryBackfill).not.toHaveBeenCalled();
  });

  it("attaches to an existing session instead of creating one", async () => {
    const onSessionCreated = vi.fn();
    getRecoverySnapshot.mockResolvedValue({
      checkpoint: null,
      delta: "replayed",
      bufferMode: "normal",
      endSeq: 0,
      checkpointEpoch: 0,
    });
    renderTerminalView({ sessionId: "existing-1", onSessionCreated });

    await waitFor(() => expect(registerOutput).toHaveBeenCalledWith("existing-1", expect.any(Function)));
    expect(createSession).not.toHaveBeenCalled();
    expect(getRecoverySnapshot).toHaveBeenCalledWith("existing-1");
    // attach 路径要对齐后端 PTY 尺寸，且不再回报 onSessionCreated
    expect(resize).toHaveBeenCalledWith({ sessionId: "existing-1", cols: 80, rows: 24 });
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("mirror attach and fit never resize the shared PTY", async () => {
    renderTerminalView({
      sessionId: "shared-session",
      paneId: undefined,
      tabId: undefined,
      drivesBackendPty: false,
    });

    await waitFor(() =>
      expect(registerOutput).toHaveBeenCalledWith("shared-session", expect.any(Function)),
    );
    expect(resize).not.toHaveBeenCalled();
    const schedulerCalls = vi.mocked(createTerminalLayoutScheduler).mock.calls;
    const schedulerOptions = schedulerCalls[schedulerCalls.length - 1]?.[0];
    expect(schedulerOptions?.canResizeBackend?.()).toBe(false);
  });

  it("standalone primary views still resize the backend PTY", async () => {
    renderTerminalView({
      sessionId: "standalone-session",
      paneId: undefined,
      tabId: undefined,
    });

    await waitFor(() =>
      expect(registerOutput).toHaveBeenCalledWith("standalone-session", expect.any(Function)),
    );
    expect(resize).toHaveBeenCalledWith({
      sessionId: "standalone-session",
      cols: 80,
      rows: 24,
    });
    const schedulerCalls = vi.mocked(createTerminalLayoutScheduler).mock.calls;
    const schedulerOptions = schedulerCalls[schedulerCalls.length - 1]?.[0];
    expect(schedulerOptions?.canResizeBackend?.()).toBe(true);
  });

  it("layout resize lets a visible terminal in an unfocused pane fit", async () => {
    useTabViewStateStore.getState().reportView("tab-1", "primary", "visible");
    renderTerminalView({
      sessionId: "inactive-pane-session",
      layoutActive: true,
    });
    await waitFor(() => expect(registerOutput).toHaveBeenCalled());
    const schedulerResults = vi.mocked(createTerminalLayoutScheduler).mock.results;
    const scheduler = schedulerResults[schedulerResults.length - 1]?.value as {
      schedule: ReturnType<typeof vi.fn>;
    };
    scheduler.schedule.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent(TERMINAL_LAYOUT_CHANGED_EVENT, {
        detail: { reason: "pane.resize" },
      }));
    });

    expect(scheduler.schedule).toHaveBeenCalledWith("layout-change.pane.resize", {
      force: true,
      allowInactive: true,
    });
  });

  it("defers PTY creation for a hidden layout and reports the restore state", async () => {
    const onRestoreLaunchState = vi.fn();
    useTabViewStateStore.getState().reportView("tab-1", "primary", "hidden");
    renderTerminalView({ layoutActive: false, restoring: true, onRestoreLaunchState });

    await waitFor(() => expect(onRestoreLaunchState).toHaveBeenCalledWith("queued"));
    expect(createSession).not.toHaveBeenCalled();
  });

  it("reattaches a background-restored session without waiting for a renderable tab", async () => {
    const onSessionCreated = vi.fn();
    const initialProps = {
      sessionId: null,
      launchId: "previous-launch",
      projectPath: "/tmp/proj",
      layoutActive: false,
      restoring: true,
      savedSessionId: "expired-session",
      paneId: "pane-1",
      tabId: "tab-1",
      onSessionCreated,
    } satisfies React.ComponentProps<typeof TerminalView>;
    const view = render(<TerminalView {...initialProps} />);

    await waitFor(() => expect(createSession).not.toHaveBeenCalled());
    act(() => {
      useTerminalStatusStore.setState({
        statusMap: new Map([["background-session", { status: "running" }]]),
      } as never);
    });

    view.rerender(
      <TerminalView
        {...initialProps}
        layoutActive
        savedSessionId="background-session"
      />,
    );

    await waitFor(() =>
      expect(registerOutput).toHaveBeenCalledWith("background-session", expect.any(Function)),
    );
    expect(onSessionCreated).toHaveBeenCalledWith("background-session");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("creates a skipped background restore without waiting for a renderable tab", async () => {
    const onSessionCreated = vi.fn();
    const initialProps = {
      sessionId: null,
      launchId: "previous-launch",
      projectPath: "/tmp/proj",
      layoutActive: false,
      restoring: true,
      savedSessionId: "expired-session",
      paneId: "pane-1",
      tabId: "tab-1",
      onSessionCreated,
    } satisfies React.ComponentProps<typeof TerminalView>;
    const view = render(<TerminalView {...initialProps} />);

    await waitFor(() => expect(createSession).not.toHaveBeenCalled());
    view.rerender(<TerminalView {...initialProps} layoutActive />);

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(onSessionCreated).toHaveBeenCalledWith("new-session-1");
  });

  it("finishes a queued restore after its layout becomes hidden again", async () => {
    const releaseBlockers: Array<() => void> = [];
    const blockers = Array.from({ length: 3 }, () =>
      terminalRestoreLaunchQueue.run(() => new Promise<void>((resolve) => {
        releaseBlockers.push(resolve);
      })),
    );
    await waitFor(() => expect(terminalRestoreLaunchQueue.getSnapshot().active).toBe(3));

    try {
      const onSessionCreated = vi.fn();
      const initialProps = {
        sessionId: null,
        launchId: "previous-launch",
        projectPath: "/tmp/proj",
        layoutActive: false,
        restoring: true,
        savedSessionId: "expired-session",
        paneId: "pane-1",
        tabId: "tab-1",
        onSessionCreated,
      } satisfies React.ComponentProps<typeof TerminalView>;
      const view = render(<TerminalView {...initialProps} />);

      view.rerender(<TerminalView {...initialProps} layoutActive />);
      await waitFor(() => expect(terminalRestoreLaunchQueue.getSnapshot().pending).toBe(1));
      view.rerender(<TerminalView {...initialProps} />);

      act(() => releaseBlockers.forEach((release) => release()));
      await Promise.all(blockers);

      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      expect(onSessionCreated).toHaveBeenCalledWith("new-session-1");
    } finally {
      act(() => releaseBlockers.forEach((release) => release()));
      await Promise.all(blockers);
    }
  });

  it("replays persisted output for a restored session before launching", async () => {
    loadOutput.mockResolvedValue(["old line 1", "old line 2"] as never);
    renderTerminalView({ restoring: true, savedSessionId: "saved-1" });

    await waitFor(() => expect(createSession).toHaveBeenCalled());
    const term = await lastTerm();
    expect(loadOutput).toHaveBeenCalledWith("saved-1");
    expect(term.writtenLines).toContain("old line 1");
    expect(term.writtenLines).toContain("old line 2");
  });

  it("kills an in-flight duplicate restore PTY when the leaf is adopted before create returns", async () => {
    const created = deferred<string>();
    const onSessionCreated = vi.fn();
    const canCreateTerminalSession = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    usePanesStore.setState({ canCreateTerminalSession } as never);
    createSession.mockReturnValue(created.promise as never);

    renderTerminalView({
      restoring: true,
      savedSessionId: "saved-1",
      onSessionCreated,
    });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    created.resolve("duplicate-session");

    await waitFor(() => expect(killSession).toHaveBeenCalledWith("duplicate-session"));
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(canCreateTerminalSession).toHaveBeenCalledWith("tab-1", "pane-1", "saved-1");
  });

  it("kills an in-flight duplicate PTY from hidden-layout activation after another restore wins", async () => {
    const created = deferred<string>();
    const onSessionCreated = vi.fn();
    const canCreateTerminalSession = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    usePanesStore.setState({ canCreateTerminalSession } as never);
    createSession.mockReturnValue(created.promise as never);

    const view = renderTerminalView({
      layoutActive: false,
      restoring: true,
      savedSessionId: "saved-1",
      onSessionCreated,
    });
    await waitFor(() => expect(createSession).not.toHaveBeenCalled());

    view.rerender(
      <TerminalView
        sessionId={null}
        launchId="previous-launch"
        projectPath="/tmp/proj"
        layoutActive
        paneId="pane-1"
        tabId="tab-1"
        restoring
        savedSessionId="saved-1"
        onSessionCreated={onSessionCreated}
      />,
    );
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    created.resolve("duplicate-activation-session");

    await waitFor(() => expect(killSession).toHaveBeenCalledWith("duplicate-activation-session"));
    expect(onSessionCreated).not.toHaveBeenCalled();
    expect(canCreateTerminalSession).toHaveBeenCalledWith("tab-1", "pane-1", "saved-1");
  });

  it("reattaches to a still-live saved session instead of relaunching", async () => {
    useTerminalStatusStore.setState({
      statusMap: new Map([["saved-live", { status: "running" }]]),
    } as never);
    renderTerminalView({ restoring: true, savedSessionId: "saved-live" });

    await waitFor(() =>
      expect(registerOutput).toHaveBeenCalledWith("saved-live", expect.any(Function))
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("forwards xterm input to the backend session", async () => {
    renderTerminalView();
    await waitFor(() => expect(registerOutput).toHaveBeenCalled());
    const term = await lastTerm();

    act(() => term.dataHandler?.("ls -la\r"));

    // 输入透传原样内容（提交回车为 \r）
    expect(writeToSession).toHaveBeenCalledWith(
      "new-session-1",
      "ls -la\r",
      expect.objectContaining({ traceId: expect.any(Number) })
    );
  });

  it("does not clear native IME state around programmatic paste", async () => {
    renderTerminalView();
    const term = await lastTerm();
    const textarea = term.textarea;
    expect(textarea).not.toBeNull();

    fireEvent.paste(textarea!, {
      clipboardData: {
        getData: vi.fn(() => "pasted text"),
      },
    });

    await waitFor(() => expect(term.paste).toHaveBeenCalledWith("pasted text"));

    const guardResults = vi.mocked(attachTerminalImeGuard).mock.results;
    const guard = guardResults[guardResults.length - 1]?.value;
    expect(guard?.clearNativeEditState).not.toHaveBeenCalled();
  });

  it("drops input typed before the session exists", async () => {
    createSession.mockReturnValue(new Promise(() => {}) as never);
    renderTerminalView();
    const term = await lastTerm();
    await waitFor(() => expect(term.dataHandler).not.toBeNull());

    act(() => term.dataHandler?.("early"));

    expect(writeToSession).not.toHaveBeenCalled();
  });

  it("writes backend output into the terminal", async () => {
    renderTerminalView();
    await waitFor(() => expect(registerOutput).toHaveBeenCalled());
    const term = await lastTerm();
    const outputHandler = registerOutput.mock.calls[0][1] as (data: string) => void;

    act(() => outputHandler("hello from pty"));

    await waitFor(() => expect(term.writtenData).toContain("hello from pty"));
  });

  it("后台标签页的输出先积压，切回可见时一次性补齐且保序", async () => {
    // 行为红线（store 驱动版）：可见性翻转不再走 props，翻 store 单视图即触发
    // 边沿 flush——与生产完全同路。
    useTabViewStateStore.getState().reportView("tab-1", "primary", "hidden");
    renderTerminalView();
    await waitFor(() => expect(registerOutput).toHaveBeenCalled());
    const term = await lastTerm();
    const outputHandler = registerOutput.mock.calls[0][1] as (data: string) => void;

    act(() => outputHandler("part-1 "));
    act(() => outputHandler("part-2"));

    // 不可见期间一个字都不该进 xterm——这正是 N 个后台会话压主线程的成本来源。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(term.writtenData).not.toContain("part-1");

    act(() => {
      useTabViewStateStore.getState().reportView("tab-1", "primary", "active");
    });

    // 切回后补齐，且顺序不变、零丢失。
    await waitFor(() => expect(term.writtenData).toContain("part-1 part-2"));
  });

  it("积压溢出后切回：走快照重建而非吐半截积压（不变式：丢弃只能整段）", async () => {
    useTabViewStateStore.getState().reportView("tab-1", "primary", "hidden");
    getRecoverySnapshot.mockResolvedValue({
      checkpoint: null,
      delta: "SNAPSHOT-REBUILD",
      bufferMode: "normal",
      endSeq: 0,
      checkpointEpoch: 0,
    });
    renderTerminalView();
    await waitFor(() => expect(registerOutput).toHaveBeenCalled());
    const term = await lastTerm();
    const outputHandler = registerOutput.mock.calls[0][1] as (data: string) => void;

    // 撑爆 512KB 隐藏积压：溢出即整体作废，后续 tail 也不该以「半截积压」形式落屏
    const big = "x".repeat(300 * 1024);
    act(() => outputHandler(big));
    act(() => outputHandler(big));
    act(() => outputHandler("tail-after-overflow"));

    act(() => {
      useTabViewStateStore.getState().reportView("tab-1", "primary", "active");
    });

    // 溢出恢复必须走统一快照重建：reset + 快照全量写入
    await waitFor(() => expect(getRecoverySnapshot).toHaveBeenCalled());
    await waitFor(() =>
      expect(term.writtenData.some((d) => d.includes("SNAPSHOT-REBUILD"))).toBe(true),
    );
    // 半截积压绝不落屏（快照之外看不到溢出期的任何原始字节）
    expect(term.writtenData.some((d) => d.includes("tail-after-overflow"))).toBe(false);
    expect(term.writtenData.some((d) => d.includes("xxxx"))).toBe(false);
  });

  it("announces process exit in the terminal and to the parent", async () => {
    const onSessionExited = vi.fn();
    renderTerminalView({ onSessionExited });
    await waitFor(() => expect(registerExit).toHaveBeenCalled());
    const term = await lastTerm();
    const exitHandler = registerExit.mock.calls[0][1] as (exitCode: number) => void;

    act(() => exitHandler(3));

    expect(onSessionExited).toHaveBeenCalledWith(3);
    expect(term.writtenLines.some((line) => line.includes("exited with code 3"))).toBe(true);
  });

  it("后台会话退出时先补齐尾部输出，再显示退出提示", async () => {
    const onSessionExited = vi.fn();
    useTabViewStateStore.getState().reportView("tab-1", "primary", "hidden");
    renderTerminalView({ onSessionExited });
    await waitFor(() => {
      expect(registerOutput).toHaveBeenCalled();
      expect(registerExit).toHaveBeenCalled();
    });
    const term = await lastTerm();
    const outputHandler = registerOutput.mock.calls[0][1] as (data: string) => void;
    const exitHandler = registerExit.mock.calls[0][1] as (exitCode: number) => void;

    act(() => outputHandler("last hidden output"));
    expect(term.writeEvents).not.toContain("last hidden output");

    act(() => exitHandler(7));

    await waitFor(() => expect(onSessionExited).toHaveBeenCalledWith(7));
    const tailIndex = term.writeEvents.findIndex((event) => event.includes("last hidden output"));
    const exitIndex = term.writeEvents.findIndex((event) => event.includes("exited with code 7"));
    expect(tailIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(tailIndex);
  });

  it("shows an install hint when the CLI binary is missing", async () => {
    createSession.mockRejectedValue(new Error("claude CLI not found"));
    renderTerminalView({ cliTool: "claude" });

    const term = await lastTerm();
    await waitFor(() =>
      expect(term.writtenLines.some((line) => line.includes("claude CLI is not installed"))).toBe(true)
    );
  });

  it("writes a generic error when session creation fails", async () => {
    createSession.mockRejectedValue(new Error("spawn refused"));
    renderTerminalView();

    const term = await lastTerm();
    await waitFor(() =>
      expect(
        term.writtenLines.some((line) =>
          line.includes("Failed to initialize terminal session") && line.includes("spawn refused")
        )
      ).toBe(true)
    );
  });

  it("reports a structured launch error to the parent", async () => {
    const onLaunchError = vi.fn();
    createSession.mockRejectedValue({
      code: "PATH_NOT_FOUND",
      message: "Launch directory does not exist",
      params: { path: "/missing/repo" },
    });

    renderTerminalView({ onLaunchError });

    await waitFor(() => expect(onLaunchError).toHaveBeenCalledWith({
      code: "PATH_NOT_FOUND",
      message: "Launch directory does not exist",
      params: { path: "/missing/repo" },
    }));
  });

  it("passes normalized terminal settings into xterm construction", async () => {
    useSettingsStore.setState({
      settings: {
        terminal: {
          fontSize: 99, // 超出上限 → 钳到 32
          fontFamily: "  ",
          cursorStyle: "bar",
          cursorBlink: true,
          scrollback: 5000,
        },
      },
    } as never);
    renderTerminalView();

    const term = await lastTerm();
    expect(term.options.fontSize).toBe(32);
    expect(String(term.options.fontFamily)).toContain("monospace");
    expect(term.options.cursorStyle).toBe("bar");
    expect(term.options.cursorBlink).toBe(true);
    expect(term.options.scrollback).toBe(5000);
  });

  it("keeps terminal text readable on contrasting TUI backgrounds", async () => {
    renderTerminalView();

    const term = await lastTerm();
    expect(term.options.minimumContrastRatio).toBe(4.5);
  });

  it("applies scrollback changes to a live terminal at runtime (clamped)", async () => {
    renderTerminalView();
    const term = await lastTerm();

    act(() => {
      useSettingsStore.setState({
        settings: {
          terminal: {
            fontSize: 15,
            fontFamily: "monospace",
            cursorStyle: "block",
            cursorBlink: false,
            scrollback: 9_999_999, // 超出上限 → 钳到 100000
          },
        },
      } as never);
    });

    await waitFor(() => expect(term.options.scrollback).toBe(100_000));
  });

  it("swallows Codex background color queries after wallpaper transparency is enabled", async () => {
    renderTerminalView({ cliTool: "codex" });
    const term = await lastTerm();
    await waitFor(() => expect(term.parser.registerOscHandler).toHaveBeenCalledTimes(3));
    const backgroundHandler = term.parser.registerOscHandler.mock.calls.find(
      ([ident]) => ident === 11,
    )?.[1] as ((data: string) => boolean) | undefined;
    expect(backgroundHandler).toBeDefined();

    act(() => {
      useWallpaperStore.setState({
        resolved: { terminalOpacity: 0.5 } as never,
        assetUrl: "asset://wallpaper",
      });
    });
    await waitFor(() => expect(registerOutput).toHaveBeenCalledWith(
      "new-session-1",
      expect.any(Function),
    ));
    writeToSession.mockClear();

    expect(backgroundHandler?.("?")).toBe(true);
    expect(writeToSession).not.toHaveBeenCalled();
  });

  it("terminal context menu drives select-all, clear and copy-buffer", async () => {
    const user = userEvent.setup();
    const view = renderTerminalView();
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    const term = await lastTerm();
    const host = view.container.querySelector(".cc-terminal-host");
    expect(host).not.toBeNull();

    fireEvent.contextMenu(host!);
    await user.click(await screen.findByRole("menuitem", { name: /全选|Select All/i }));
    expect(term.selectAll).toHaveBeenCalled();

    fireEvent.contextMenu(host!);
    await user.click(await screen.findByRole("menuitem", { name: /清空缓冲区|Clear Buffer/i }));
    expect(term.clear).toHaveBeenCalled();

    fireEvent.contextMenu(host!);
    await user.click(
      await screen.findByRole("menuitem", { name: /复制整个缓冲区|Copy Entire Buffer/i })
    );
    await waitFor(() => expect(vi.mocked(writeText)).toHaveBeenCalledWith("line-0\nline-1"));
  });

  it("terminal context menu refreshes the renderer and copies the session id", async () => {
    const user = userEvent.setup();
    const view = renderTerminalView();
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    await waitFor(() => expect(registerOutput).toHaveBeenCalled());
    const host = view.container.querySelector(".cc-terminal-host");
    expect(host).not.toBeNull();

    const controllerResults = vi.mocked(createTerminalRendererController).mock.results;
    const controller = controllerResults[controllerResults.length - 1]
      .value as { clearTextureAtlas: ReturnType<typeof vi.fn> };

    resize.mockClear();
    fireEvent.contextMenu(host!);
    await user.click(await screen.findByRole("menuitem", { name: /刷新终端|Refresh Terminal/i }));
    expect(controller.clearTextureAtlas).toHaveBeenCalledWith("context-menu.refresh");

    // 渲染层重画救不了 buffer 级错乱（docs/73），必须同时向 CLI 抖一次 SIGWINCH：
    // 先缩一列，再抖回原宽度。
    await waitFor(() =>
      expect(resize).toHaveBeenCalledWith({ sessionId: "new-session-1", cols: 79, rows: 24 }),
    );
    await waitFor(() =>
      expect(resize).toHaveBeenCalledWith({ sessionId: "new-session-1", cols: 80, rows: 24 }),
    );

    fireEvent.contextMenu(host!);
    await user.click(await screen.findByRole("menuitem", { name: /复制会话 ID|Copy Session ID/i }));
    await waitFor(() => expect(vi.mocked(writeText)).toHaveBeenCalledWith("new-session-1"));
  });

  it("mirror panes never send the refresh SIGWINCH to the shared PTY", async () => {
    const user = userEvent.setup();
    const view = renderTerminalView({
      sessionId: "shared-session",
      paneId: undefined,
      tabId: undefined,
      drivesBackendPty: false,
    });
    await waitFor(() => expect(registerOutput).toHaveBeenCalled());
    const host = view.container.querySelector(".cc-terminal-host");
    expect(host).not.toBeNull();

    resize.mockClear();
    fireEvent.contextMenu(host!);
    await user.click(await screen.findByRole("menuitem", { name: /刷新终端|Refresh Terminal/i }));

    // 镜像面板改后端尺寸会连带改掉主视图的 PTY，必须完全不发。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(resize).not.toHaveBeenCalled();
  });

  it("terminal context menu fits the current terminal and requests all terminals to fit", async () => {
    const user = userEvent.setup();
    const view = renderTerminalView();
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    const host = view.container.querySelector(".cc-terminal-host");
    expect(host).not.toBeNull();
    const schedulerResults = vi.mocked(createTerminalLayoutScheduler).mock.results;
    const scheduler = schedulerResults[schedulerResults.length - 1]?.value as {
      schedule: ReturnType<typeof vi.fn>;
      flush: ReturnType<typeof vi.fn>;
    };
    scheduler.schedule.mockClear();
    scheduler.flush.mockClear();
    const fitAllListener = vi.fn();
    window.addEventListener(TERMINAL_FIT_ALL_EVENT, fitAllListener);

    fireEvent.contextMenu(host!);
    await user.click(
      await screen.findByRole("menuitem", { name: /^(适应大小|Fit Terminal)$/i }),
    );
    expect(scheduler.flush).toHaveBeenCalledWith("context-menu.fit", {
      force: true,
      focusIfSafe: true,
      allowInactive: true,
    });

    fireEvent.contextMenu(host!);
    await user.click(
      await screen.findByRole("menuitem", { name: /全部终端适应大小|Fit All Terminals/i }),
    );
    expect(fitAllListener).toHaveBeenCalledTimes(1);
    expect(scheduler.schedule).toHaveBeenCalledWith("context-menu.fit-all", {
      force: true,
      allowInactive: true,
    });
    window.removeEventListener(TERMINAL_FIT_ALL_EVENT, fitAllListener);
  });

  it("disposes the terminal on unmount", async () => {
    const view = renderTerminalView();
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    const term = await lastTerm();

    view.unmount();

    expect(term.disposed).toBe(true);
  });
});
