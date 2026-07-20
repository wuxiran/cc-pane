import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore, useTerminalStatusStore } from "@/stores";
import { historyService, sessionRestoreService, terminalService } from "@/services";
import { createTerminalRendererController } from "./terminalRendererController";
import TerminalView from "./TerminalView";

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
    registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })),
  };
  writtenLines: string[] = [];
  writtenData: string[] = [];
  dataHandler: ((data: string) => void) | null = null;
  keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;
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
    callback?.();
  }

  writeln(line: string) {
    this.writtenLines.push(line);
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
    return { dispose: vi.fn() };
  }

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

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn().mockResolvedValue(undefined),
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
    detachOutput: vi.fn(),
    detachExit: vi.fn(),
    resize: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    getReplaySnapshot: vi.fn().mockResolvedValue(null),
    getAllStatus: vi.fn().mockResolvedValue([]),
  },
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
const getReplaySnapshot = vi.mocked(terminalService.getReplaySnapshot);
const startLaunchHistoryBackfill = vi.mocked(historyService.startLaunchHistoryBackfill);
const loadOutput = vi.mocked(sessionRestoreService.loadOutput);

function renderTerminalView(props?: Partial<React.ComponentProps<typeof TerminalView>>) {
  return render(
    <TerminalView
      sessionId={null}
      projectId="proj-1"
      projectPath="/tmp/proj"
      isActive
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
    useSettingsStore.setState({ settings: undefined } as never);
    useTerminalStatusStore.setState({ statusMap: new Map() } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("creates a backend session sized to the terminal and reports it", async () => {
    const onSessionCreated = vi.fn();
    renderTerminalView({ onSessionCreated, cliTool: "none" });

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        launchId: "proj-1",
        projectPath: "/tmp/proj",
        cols: 80,
        rows: 24,
        cliTool: "none",
      })
    );

    await waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith("new-session-1"));
    expect(registerOutput).toHaveBeenCalledWith("new-session-1", expect.any(Function));
    expect(registerExit).toHaveBeenCalledWith("new-session-1", expect.any(Function));
    // 新建会话不回放快照
    expect(getReplaySnapshot).not.toHaveBeenCalled();
  });

  it("backfills launch history for CLI sessions without a resume id", async () => {
    renderTerminalView({ cliTool: "claude" });

    await waitFor(() => expect(startLaunchHistoryBackfill).toHaveBeenCalled());
    const call = startLaunchHistoryBackfill.mock.calls[0];
    expect(call[0]).toBe("proj-1");
    expect(call[1]).toBe("new-session-1");
    expect(call[2]).toBe("claude");
    expect(call[3]).toBe("local");
  });

  it("skips history backfill for plain shells", async () => {
    renderTerminalView({ cliTool: "none" });

    await waitFor(() => expect(createSession).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startLaunchHistoryBackfill).not.toHaveBeenCalled();
  });

  it("attaches to an existing session instead of creating one", async () => {
    const onSessionCreated = vi.fn();
    getReplaySnapshot.mockResolvedValue({
      lines: ["replayed"],
      cursorRow: 0,
      alternateActive: false,
    } as never);
    renderTerminalView({ sessionId: "existing-1", onSessionCreated });

    await waitFor(() => expect(registerOutput).toHaveBeenCalledWith("existing-1", expect.any(Function)));
    expect(createSession).not.toHaveBeenCalled();
    expect(getReplaySnapshot).toHaveBeenCalledWith("existing-1");
    // attach 路径要对齐后端 PTY 尺寸，且不再回报 onSessionCreated
    expect(resize).toHaveBeenCalledWith({ sessionId: "existing-1", cols: 80, rows: 24 });
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it("defers PTY creation for a hidden layout and reports the restore state", async () => {
    const onRestoreLaunchState = vi.fn();
    renderTerminalView({ layoutActive: false, restoring: true, onRestoreLaunchState });

    await waitFor(() => expect(onRestoreLaunchState).toHaveBeenCalledWith("queued"));
    expect(createSession).not.toHaveBeenCalled();
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

    fireEvent.contextMenu(host!);
    await user.click(await screen.findByRole("menuitem", { name: /刷新终端|Refresh Terminal/i }));
    expect(controller.clearTextureAtlas).toHaveBeenCalledWith("context-menu.refresh");

    fireEvent.contextMenu(host!);
    await user.click(await screen.findByRole("menuitem", { name: /复制会话 ID|Copy Session ID/i }));
    await waitFor(() => expect(vi.mocked(writeText)).toHaveBeenCalledWith("new-session-1"));
  });

  it("disposes the terminal on unmount", async () => {
    const view = renderTerminalView();
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    const term = await lastTerm();

    view.unmount();

    expect(term.disposed).toBe(true);
  });
});
