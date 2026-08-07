// M3b-2：checkpoint 上传 capability 关断 + 补拍请求分发。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { TerminalCheckpointUpload } from "@/types";
import {
  _resetCheckpointCapabilityForTest,
  _resetCheckpointRequestForTest,
  registerCheckpointRequest,
  uploadCheckpoint,
} from "./terminalCheckpoint";

const CHECKPOINT: TerminalCheckpointUpload = {
  checkpointEpoch: 7,
  anchorSeq: 5,
  snapshotAnsi: "PHOTO",
  bufferMode: "normal",
  cols: 80,
  rows: 24,
  checkpointedAtMs: 1,
};

function invokeCalls(command: string): unknown[][] {
  return (invoke as ReturnType<typeof vi.fn>).mock.calls.filter(([cmd]) => cmd === command);
}

beforeEach(() => {
  resetTauriInvoke();
  _resetCheckpointCapabilityForTest();
  _resetCheckpointRequestForTest();
});

describe("uploadCheckpoint", () => {
  it("经 upload_terminal_checkpoint 命令上传并透传结构化 outcome", async () => {
    mockTauriInvoke({
      upload_terminal_checkpoint: { kind: "accepted", anchorSeq: 5 },
    });

    const outcome = await uploadCheckpoint("s1", CHECKPOINT);

    expect(outcome).toEqual({ kind: "accepted", anchorSeq: 5 });
    expect(invoke).toHaveBeenCalledWith("upload_terminal_checkpoint", {
      sessionId: "s1",
      checkpoint: CHECKPOINT,
    });
  });

  it("拒收是结果不是错误：rejected 变体原样返回", async () => {
    mockTauriInvoke({
      upload_terminal_checkpoint: { kind: "rejectedStaleAnchor" },
    });

    await expect(uploadCheckpoint("s1", CHECKPOINT)).resolves.toEqual({
      kind: "rejectedStaleAnchor",
    });
  });

  it("首个 CHECKPOINT_UNSUPPORTED 后 capability 关断：后续调用短路 no-op", async () => {
    // Tauri 拒绝值是序列化的 AppError 对象 { code, message }
    mockTauriInvoke({
      upload_terminal_checkpoint: () =>
        Promise.reject({ code: "CHECKPOINT_UNSUPPORTED", message: "no endpoint" }),
    });

    await expect(uploadCheckpoint("s1", CHECKPOINT)).resolves.toBeNull();
    expect(invokeCalls("upload_terminal_checkpoint")).toHaveLength(1);

    // 即使后端此后可用，也不再探测（关断是进程级缓存）
    (invoke as ReturnType<typeof vi.fn>).mockClear();
    mockTauriInvoke({
      upload_terminal_checkpoint: { kind: "accepted", anchorSeq: 5 },
    });
    await expect(uploadCheckpoint("s1", CHECKPOINT)).resolves.toBeNull();
    expect(invokeCalls("upload_terminal_checkpoint")).toHaveLength(0);
  });

  it("也识别 `[CODE] message` 文本形态的 CHECKPOINT_UNSUPPORTED", async () => {
    mockTauriInvoke({
      upload_terminal_checkpoint: () =>
        Promise.reject(new Error("[CHECKPOINT_UNSUPPORTED] daemon has no checkpoint endpoint")),
    });

    await expect(uploadCheckpoint("s1", CHECKPOINT)).resolves.toBeNull();
    await expect(uploadCheckpoint("s1", CHECKPOINT)).resolves.toBeNull();
    expect(invokeCalls("upload_terminal_checkpoint")).toHaveLength(1);
  });

  it("其他错误按错误上抛且不关断 capability", async () => {
    mockTauriInvoke({
      upload_terminal_checkpoint: () =>
        Promise.reject({ code: "SESSION_CLAIMED", message: "held" }),
    });

    await expect(uploadCheckpoint("s1", CHECKPOINT)).rejects.toBeTruthy();

    mockTauriInvoke({
      upload_terminal_checkpoint: { kind: "accepted", anchorSeq: 5 },
    });
    await expect(uploadCheckpoint("s1", CHECKPOINT)).resolves.toEqual({
      kind: "accepted",
      anchorSeq: 5,
    });
  });

  it("_resetCheckpointCapabilityForTest 恢复探测", async () => {
    mockTauriInvoke({
      upload_terminal_checkpoint: () =>
        Promise.reject({ code: "CHECKPOINT_UNSUPPORTED", message: "no endpoint" }),
    });
    await uploadCheckpoint("s1", CHECKPOINT);

    _resetCheckpointCapabilityForTest();
    mockTauriInvoke({
      upload_terminal_checkpoint: { kind: "accepted", anchorSeq: 5 },
    });
    await expect(uploadCheckpoint("s1", CHECKPOINT)).resolves.toEqual({
      kind: "accepted",
      anchorSeq: 5,
    });
  });
});

describe("registerCheckpointRequest", () => {
  type RequestHandler = (event: { payload: { sessionId: string } }) => void;

  async function getRequestHandler(): Promise<RequestHandler> {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const listenMock = vi.mocked(getCurrentWebview().listen);
    const entry = listenMock.mock.calls.find(([event]) => event === "terminal-checkpoint-request");
    expect(entry).toBeDefined();
    return entry![1] as unknown as RequestHandler;
  }

  async function listenCallCount(): Promise<number> {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return vi
      .mocked(getCurrentWebview().listen)
      .mock.calls.filter(([event]) => event === "terminal-checkpoint-request").length;
  }

  it("按 sessionId 分发补拍请求，unsubscribe 只摘掉自己", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = await registerCheckpointRequest("s1", a);
    await registerCheckpointRequest("s1", b);

    const handler = await getRequestHandler();
    handler({ payload: { sessionId: "s1" } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    // 其他会话的请求不串台
    handler({ payload: { sessionId: "s2" } });
    expect(a).toHaveBeenCalledTimes(1);

    unsubA();
    handler({ payload: { sessionId: "s1" } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("监听器只装一次：多会话多订阅共用同一个 listen（18 标签各装一次会重复分发）", async () => {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    vi.mocked(getCurrentWebview().listen).mockClear();

    await registerCheckpointRequest("s1", vi.fn());
    await registerCheckpointRequest("s1", vi.fn());
    await registerCheckpointRequest("s2", vi.fn());

    expect(await listenCallCount()).toBe(1);
  });

  it("无订阅者的会话请求直接丢弃，不抛（best-effort：daemon 30s 会重发）", async () => {
    await registerCheckpointRequest("s1", vi.fn());
    const handler = await getRequestHandler();
    expect(() => handler({ payload: { sessionId: "never-registered" } })).not.toThrow();
  });

  it("重复 unsubscribe 幂等，不影响同会话其他订阅者", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = await registerCheckpointRequest("s1", a);
    await registerCheckpointRequest("s1", b);

    unsubA();
    unsubA();

    const handler = await getRequestHandler();
    handler({ payload: { sessionId: "s1" } });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("最后一个订阅者退订后，该会话的请求不再命中任何回调", async () => {
    const a = vi.fn();
    const unsub = await registerCheckpointRequest("s1", a);
    const handler = await getRequestHandler();

    unsub();
    handler({ payload: { sessionId: "s1" } });

    expect(a).not.toHaveBeenCalled();
  });

  it("_resetCheckpointRequestForTest 会真的 unlisten（否则测试间监听器堆积）", async () => {
    const unlisten = vi.fn();
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    vi.mocked(getCurrentWebview().listen).mockResolvedValueOnce(unlisten as never);

    await registerCheckpointRequest("s1", vi.fn());
    _resetCheckpointRequestForTest();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("web 模式（无 Tauri）不注册监听器——没有 control 通道，事件永不到达", async () => {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    vi.mocked(getCurrentWebview().listen).mockClear();

    const internals = window.__TAURI_INTERNALS__;
    // 模拟浏览器端：删掉 Tauri 注入（isTauriRuntime 就是看这个字段）
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    try {
      // 订阅本身仍成功（返回可用的 unsubscribe），只是事件源不存在
      const unsub = await registerCheckpointRequest("s1", vi.fn());
      expect(typeof unsub).toBe("function");
      expect(await listenCallCount()).toBe(0);
      expect(() => unsub()).not.toThrow();
    } finally {
      window.__TAURI_INTERNALS__ = internals;
    }
  });
});
