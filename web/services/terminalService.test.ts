import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { _resetListenersForTest, terminalService } from "./terminalService";
import {
  mockTauriInvoke,
  mockTauriInvokeError,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import {
  _resetTerminalRestoreBarrierForTest,
  beginTerminalRestoreBarrier,
  finishTerminalRestoreBarrier,
} from "./terminalRestoreBarrier";

describe("terminalService", () => {
  beforeEach(() => {
    resetTauriInvoke();
    _resetListenersForTest();
    _resetTerminalRestoreBarrierForTest();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetListenersForTest();
    _resetTerminalRestoreBarrierForTest();
  });

  describe("多订阅分发（星标镜像：同一会话多视图）", () => {
    type OutputHandler = (
      event: { payload: { sessionId: string; data: string; endSeq?: number } },
    ) => void;

    async function getOutputHandler(): Promise<OutputHandler> {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const listenMock = vi.mocked(getCurrentWebview().listen);
      const entry = listenMock.mock.calls.find(([event]) => event === "terminal-output");
      expect(entry).toBeDefined();
      return entry![1] as unknown as OutputHandler;
    }

    it("delivers output to every subscriber of the same session", async () => {
      mockTauriInvoke({});
      const a = vi.fn();
      const b = vi.fn();
      await terminalService.registerOutput("s-multi", a);
      await terminalService.registerOutput("s-multi", b);

      const handler = await getOutputHandler();
      handler({ payload: { sessionId: "s-multi", data: "hello" } });

      expect(a).toHaveBeenCalledWith("hello");
      expect(b).toHaveBeenCalledWith("hello");
    });

    it("unsubscribe removes only the caller's callback", async () => {
      mockTauriInvoke({});
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = await terminalService.registerOutput("s-unsub", a);
      await terminalService.registerOutput("s-unsub", b);

      unsubA();
      const handler = await getOutputHandler();
      handler({ payload: { sessionId: "s-unsub", data: "after" } });

      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledWith("after");
    });

    it("flushes pending buffers only to the first subscriber", async () => {
      mockTauriInvoke({});
      // 无订阅者时先来输出 → 进缓冲
      const warmup = vi.fn();
      const unsubWarmup = await terminalService.registerOutput("s-flush-init", warmup);
      unsubWarmup();
      const handler = await getOutputHandler();
      handler({ payload: { sessionId: "s-flush", data: "early" } });

      const first = vi.fn();
      await terminalService.registerOutput("s-flush", first);
      expect(first).toHaveBeenCalledWith("early", undefined);

      const second = vi.fn();
      await terminalService.registerOutput("s-flush", second);
      // 第二订阅者不吃缓冲（缓冲已清），走 replay 快照铺底
      expect(second).not.toHaveBeenCalled();
    });

    it("flush 透传 endSeq（不透传会让该会话永久拍不出 checkpoint）", async () => {
      mockTauriInvoke({});
      const warmup = vi.fn();
      const unsubWarmup = await terminalService.registerOutput("s-flush-seq-init", warmup);
      unsubWarmup();
      const handler = await getOutputHandler();
      handler({ payload: { sessionId: "s-flush-seq", data: "early", endSeq: 42 } });

      const first = vi.fn();
      await terminalService.registerOutput("s-flush-seq", first);
      // 旧实现在 flush 时调的是 callback(data)，丢掉了 endSeq —— 这批 chunk 的
      // received 记了、written 永远记不上，anchorCandidate 恒 null
      // （terminalOutputSeqTracker.ts:109），该会话此后再也拍不出 checkpoint。
      expect(first).toHaveBeenCalledWith("early", 42);
    });

    it("detachOutput clears all subscribers (kill-path semantics)", async () => {
      mockTauriInvoke({});
      const a = vi.fn();
      const b = vi.fn();
      await terminalService.registerOutput("s-detach", a);
      await terminalService.registerOutput("s-detach", b);

      terminalService.detachOutput("s-detach");
      const handler = await getOutputHandler();
      handler({ payload: { sessionId: "s-detach", data: "gone" } });

      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });

    it("exit event reaches every exit subscriber", async () => {
      mockTauriInvoke({});
      const a = vi.fn();
      const b = vi.fn();
      await terminalService.registerExit("s-exit", a);
      await terminalService.registerExit("s-exit", b);

      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const listenMock = vi.mocked(getCurrentWebview().listen);
      const entry = listenMock.mock.calls.find(([event]) => event === "terminal-exit");
      expect(entry).toBeDefined();
      const handler = entry![1] as unknown as (event: {
        payload: { sessionId: string; exitCode: number };
      }) => void;
      handler({ payload: { sessionId: "s-exit", exitCode: 3 } });

      expect(a).toHaveBeenCalledWith(3);
      expect(b).toHaveBeenCalledWith(3);
    });
  });

  describe("session-killed reason 分流", () => {
    type KilledHandler = (event: {
      payload: { sessionId: string; reason?: string };
    }) => Promise<void> | void;

    async function registerKilledListenerAndSession(sessionId: string) {
      mockTauriInvoke({});
      const exitCallback = vi.fn();
      await terminalService.registerExit(sessionId, exitCallback);
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const listenMock = vi.mocked(getCurrentWebview().listen);
      const killedEntry = listenMock.mock.calls.find(([event]) => event === "session-killed");
      expect(killedEntry).toBeDefined();
      return { handler: killedEntry![1] as unknown as KilledHandler, exitCallback };
    }

    it("closes the tab for mcp / legacy no-reason kills", async () => {
      const { handler } = await registerKilledListenerAndSession("s-mcp");
      const closeTabBySessionId = vi.fn();
      const { usePanesStore } = await import("@/stores/usePanesStore");
      const getStateSpy = vi
        .spyOn(usePanesStore, "getState")
        .mockReturnValue({ closeTabBySessionId } as never);

      await handler({ payload: { sessionId: "s-mcp", reason: "mcp" } });
      await handler({ payload: { sessionId: "s-mcp" } });

      expect(closeTabBySessionId).toHaveBeenCalledTimes(2);
      getStateSpy.mockRestore();
    });

    it("keeps the tab and drives the exit callback for reclaim kills", async () => {
      const { handler, exitCallback } = await registerKilledListenerAndSession("s-reclaim");
      const closeTabBySessionId = vi.fn();
      const { usePanesStore } = await import("@/stores/usePanesStore");
      const getStateSpy = vi
        .spyOn(usePanesStore, "getState")
        .mockReturnValue({ closeTabBySessionId } as never);

      await handler({ payload: { sessionId: "s-reclaim", reason: "orphan-reclaim" } });
      await handler({ payload: { sessionId: "s-reclaim", reason: "daemon-reaper" } });

      expect(closeTabBySessionId).not.toHaveBeenCalled();
      expect(exitCallback).toHaveBeenCalledTimes(2);
      expect(exitCallback).toHaveBeenCalledWith(-1);
      getStateSpy.mockRestore();
    });

    it("still suppresses kills the frontend initiated itself", async () => {
      const { handler } = await registerKilledListenerAndSession("s-self");
      mockTauriInvoke({ kill_terminal_idempotent: undefined });
      await terminalService.killSession("s-self", "orphan-reclaim");

      const closeTabBySessionId = vi.fn();
      const { usePanesStore } = await import("@/stores/usePanesStore");
      const getStateSpy = vi
        .spyOn(usePanesStore, "getState")
        .mockReturnValue({ closeTabBySessionId } as never);

      await handler({ payload: { sessionId: "s-self", reason: "mcp" } });

      expect(closeTabBySessionId).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledWith("kill_terminal_idempotent", {
        sessionId: "s-self",
        reason: "orphan-reclaim",
      });
      getStateSpy.mockRestore();
    });
  });

  describe("createSession", () => {
    it("calls create_terminal_session with a request object", async () => {
      mockTauriInvoke({ create_terminal_session: "session-1" });

      const result = await terminalService.createSession({
        projectPath: "/tmp/project",
        cols: 80,
        rows: 24,
        cliTool: "claude",
        expectedSavedSessionId: "saved-session-1",
      });

      expect(invoke).toHaveBeenCalledWith("create_terminal_session", {
        request: {
          projectPath: "/tmp/project",
          cols: 80,
          rows: 24,
          cliTool: "claude",
          expectedSavedSessionId: "saved-session-1",
        },
      });
      expect(result).toBe("session-1");
    });

    it("omits null optional fields before invoking Tauri", async () => {
      mockTauriInvoke({ create_terminal_session: "session-1" });

      await terminalService.createSession({
        projectPath: "/tmp/project",
        cols: 80,
        rows: 24,
        providerSelection: null,
        resumeId: null,
      } as never);

      expect(invoke).toHaveBeenCalledWith("create_terminal_session", {
        request: {
          projectPath: "/tmp/project",
          cols: 80,
          rows: 24,
        },
      });
    });

    it("rejects a null request before invoking Tauri", async () => {
      await expect(
        terminalService.createSession(null),
      ).rejects.toThrow("create_terminal_session requires a non-null request");

      expect(invoke).not.toHaveBeenCalled();
    });

    it("times out a normal launch and requests backend cancellation", async () => {
      vi.useFakeTimers();
      mockTauriInvoke({
        create_terminal_session: () => new Promise(() => {}),
        cancel_terminal_launch: undefined,
      });

      const result = terminalService.createSession({
        launchId: "launch-timeout",
        projectPath: "/tmp/project",
        cols: 80,
        rows: 24,
      });
      const assertion = expect(result).rejects.toMatchObject({ code: "LAUNCH_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(55_000);
      await assertion;
      expect(invoke).toHaveBeenCalledWith("cancel_terminal_launch", {
        launchId: "launch-timeout",
      });
    });

    it("bounds the startup restore barrier before backend invocation", async () => {
      vi.useFakeTimers();
      beginTerminalRestoreBarrier();
      mockTauriInvoke({
        create_terminal_session: "session-late",
        cancel_terminal_launch: undefined,
      });

      const result = terminalService.createSession({
        launchId: "launch-barrier-timeout",
        projectPath: "/tmp/project",
        cols: 80,
        rows: 24,
      });
      const assertion = expect(result).rejects.toMatchObject({ code: "LAUNCH_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(55_000);
      await assertion;
      expect(invoke).not.toHaveBeenCalledWith("create_terminal_session", expect.anything());

      finishTerminalRestoreBarrier();
      await Promise.resolve();
    });
  });

  describe("write", () => {
    it("batches rapid terminal input for the same session", async () => {
      vi.useFakeTimers();
      mockTauriInvoke({ write_terminal: undefined, record_terminal_input: undefined });

      const first = terminalService.write("session-1", "a");
      const second = terminalService.write("session-1", "b");
      const third = terminalService.write("session-1", "c");

      await vi.advanceTimersByTimeAsync(8);
      await Promise.all([first, second, third]);

      // 同源的三段仍合成一次写入；source 随请求过去，后端据此决定回显开着时
      // 该不该抑制（用户按键不抑制，前端代答的查询回复才抑制）。
      expect(invoke).toHaveBeenCalledWith("write_terminal", {
        sessionId: "session-1",
        data: "abc",
        source: "user-keyboard",
      });
      expect((invoke as ReturnType<typeof vi.fn>).mock.calls.filter(([cmd]) => cmd === "write_terminal")).toHaveLength(1);
    });

    it("preserves per-session input order across flushes", async () => {
      vi.useFakeTimers();
      const writes: string[] = [];
      const resolvers: Array<() => void> = [];
      const invokeMock = invoke as ReturnType<typeof vi.fn>;
      invokeMock.mockImplementation((cmd: string, args?: { data?: string }) => {
        if (cmd === "record_terminal_input") return Promise.resolve();
        if (cmd !== "write_terminal") {
          return Promise.reject(new Error(`Unhandled invoke command: ${cmd}`));
        }
        writes.push(args?.data ?? "");
        return new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      });

      const first = terminalService.write("session-1", "a");
      await vi.advanceTimersByTimeAsync(8);
      expect(writes).toEqual(["a"]);

      const second = terminalService.write("session-1", "b");
      const third = terminalService.write("session-1", "c");
      await vi.advanceTimersByTimeAsync(8);
      expect(writes).toEqual(["a"]);

      resolvers.shift()?.();
      await first;
      await vi.runOnlyPendingTimersAsync();
      expect(writes).toEqual(["a", "bc"]);

      resolvers.shift()?.();
      await Promise.all([second, third]);
    });

    it("drains queued keyboard input before submitToSession", async () => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const writeResolvers: Array<() => void> = [];
      const invokeMock = invoke as ReturnType<typeof vi.fn>;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "record_terminal_input") return Promise.resolve();
        if (cmd === "write_terminal") {
          calls.push("write");
          return new Promise<void>((resolve) => writeResolvers.push(resolve));
        }
        if (cmd === "submit_to_session") {
          calls.push("submit");
          return Promise.resolve();
        }
        return Promise.reject(new Error(`Unhandled invoke command: ${cmd}`));
      });

      const write = terminalService.write("session-1", "a");
      const submit = terminalService.submitToSession("session-1", "prompt");
      await vi.runOnlyPendingTimersAsync();

      expect(calls).toEqual(["write"]);
      writeResolvers.shift()?.();
      await write;
      await submit;
      expect(calls).toEqual(["write", "submit"]);
    });

    it("SESSION_CLAIMED 会广播统一租约丢失事件", async () => {
      vi.useFakeTimers();
      mockTauriInvokeError("write_terminal", "SESSION_CLAIMED: held by app-b");
      const onClaimLost = vi.fn();
      window.addEventListener("cc-panes:terminal-claim-lost", onClaimLost);

      const write = terminalService.write("session-claimed", "x");
      const rejectedWrite = expect(write).rejects.toThrow("SESSION_CLAIMED");
      await vi.advanceTimersByTimeAsync(8);
      await rejectedWrite;

      expect(onClaimLost).toHaveBeenCalledTimes(1);
      expect((onClaimLost.mock.calls[0][0] as CustomEvent).detail).toEqual({
        sessionId: "session-claimed",
      });
      window.removeEventListener("cc-panes:terminal-claim-lost", onClaimLost);
    });
  });

  describe("adoption lease API", () => {
    it("读取完整快照并缓存当前 backend instance", async () => {
      const snapshot = {
        claimsSupported: true,
        daemonGeneration: 42,
        ownerInstanceId: "app-current",
        capturedAtMs: 1,
        complete: true,
        sessions: [],
        claims: {},
        provenance: {},
      };
      mockTauriInvoke({ get_terminal_adoption_snapshot: snapshot });

      expect(await terminalService.getAdoptionSnapshot()).toEqual(snapshot);
      expect(terminalService.getCachedDaemonClientInfo()).toMatchObject({
        claimsSupported: true,
        daemonGeneration: 42,
        instanceId: "app-current",
      });
    });

    it("读取快照后保留此前探测到的进程内 backend 模式", async () => {
      mockTauriInvoke({
        get_terminal_daemon_client_info: {
          mode: "in-process",
          claimsSupported: false,
        },
        get_terminal_adoption_snapshot: {
          claimsSupported: false,
          capturedAtMs: 1,
          complete: true,
          sessions: [],
          claims: {},
          provenance: {},
        },
      });

      await terminalService.getDaemonClientInfo();
      await terminalService.getAdoptionSnapshot();

      expect(terminalService.getCachedDaemonClientInfo()).toMatchObject({
        mode: "in-process",
        claimsSupported: false,
      });
    });

    it("claim 和 detach 分别调用 adopt/release IPC", async () => {
      mockTauriInvoke({
        adopt_terminal_session: true,
        release_terminal_session: undefined,
      });

      await expect(terminalService.adoptSession("session-1")).resolves.toBe(true);
      await terminalService.releaseSession("session-1");

      expect(invoke).toHaveBeenCalledWith("adopt_terminal_session", { sessionId: "session-1" });
      expect(invoke).toHaveBeenCalledWith("release_terminal_session", { sessionId: "session-1" });
    });
  });

  describe("endSeq 记账接线（M3b-2）", () => {
    type SeqOutputHandler = (event: {
      payload: { sessionId: string; data: string; endSeq?: number };
    }) => void;

    async function getSeqOutputHandler(): Promise<SeqOutputHandler> {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const listenMock = vi.mocked(getCurrentWebview().listen);
      const entry = listenMock.mock.calls.find(([event]) => event === "terminal-output");
      expect(entry).toBeDefined();
      return entry![1] as unknown as SeqOutputHandler;
    }

    it("带 endSeq 的输出推进 tracker 的 received（in-flight 禁拍可观测），并把 endSeq 传给订阅者", async () => {
      const { _resetSeqTrackersForTest, anchorCandidate, reanchorSeq } = await import(
        "@/components/panes/terminalOutputSeqTracker"
      );
      _resetSeqTrackersForTest();
      mockTauriInvoke({});
      const subscriber = vi.fn();
      await terminalService.registerOutput("s-seq", subscriber);
      reanchorSeq("s-seq", 4, 1);
      expect(anchorCandidate("s-seq")).toEqual({ anchorSeq: 4, checkpointEpoch: 1 });

      const handler = await getSeqOutputHandler();
      handler({ payload: { sessionId: "s-seq", data: "a" } });
      // 无 endSeq（旧 daemon/轮询降级）：记账不动
      expect(anchorCandidate("s-seq")).toEqual({ anchorSeq: 4, checkpointEpoch: 1 });

      handler({ payload: { sessionId: "s-seq", data: "b", endSeq: 9 } });
      // received 推进到 9，written 还在 4 → in-flight 禁拍
      expect(anchorCandidate("s-seq")).toBeNull();
      expect(subscriber).toHaveBeenCalledWith("b", 9);
      _resetSeqTrackersForTest();
    });

    it("desync 事件作废 seq 记账（即使无 desync 订阅者）", async () => {
      const { _resetSeqTrackersForTest, anchorCandidate, reanchorSeq } = await import(
        "@/components/panes/terminalOutputSeqTracker"
      );
      _resetSeqTrackersForTest();
      mockTauriInvoke({});
      // 注册任一监听器以初始化全局 listeners
      await terminalService.registerOutput("s-desync", vi.fn());
      reanchorSeq("s-desync", 10, 2);

      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const listenMock = vi.mocked(getCurrentWebview().listen);
      const entry = listenMock.mock.calls.find(([event]) => event === "terminal-desync");
      expect(entry).toBeDefined();
      const handler = entry![1] as unknown as (event: {
        payload: { sessionId: string };
      }) => void;
      handler({ payload: { sessionId: "s-desync" } });

      expect(anchorCandidate("s-desync")).toBeNull();
      _resetSeqTrackersForTest();
    });

    it("killSession 清掉 seq 记账（会话键卫星态随销毁回收）", async () => {
      const { _resetSeqTrackersForTest, anchorCandidate, reanchorSeq } = await import(
        "@/components/panes/terminalOutputSeqTracker"
      );
      _resetSeqTrackersForTest();
      mockTauriInvoke({ kill_terminal_idempotent: undefined });
      reanchorSeq("s-kill", 10, 2);
      expect(anchorCandidate("s-kill")).not.toBeNull();

      await terminalService.killSession("s-kill");

      expect(anchorCandidate("s-kill")).toBeNull();
      _resetSeqTrackersForTest();
    });
  });

  describe("getReplaySnapshot", () => {
    it("calls get_terminal_replay_snapshot and returns the snapshot", async () => {
      const snapshot = {
        data: "\x1b[?1049hhello",
        bufferMode: "alternate" as const,
      };
      mockTauriInvoke({ get_terminal_replay_snapshot: snapshot });

      const result = await terminalService.getReplaySnapshot("session-1");

      expect(invoke).toHaveBeenCalledWith("get_terminal_replay_snapshot", {
        sessionId: "session-1",
      });
      expect(result).toEqual(snapshot);
    });

    it("supports sessions without a replay snapshot", async () => {
      mockTauriInvoke({ get_terminal_replay_snapshot: null });

      const result = await terminalService.getReplaySnapshot("session-2");

      expect(result).toBeNull();
    });
  });
});
