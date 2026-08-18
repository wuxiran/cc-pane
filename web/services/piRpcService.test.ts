import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriRuntimeMock, listenIfTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriRuntimeMock: vi.fn(() => true),
  listenIfTauriMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/services/runtime", () => ({
  isTauriRuntime: isTauriRuntimeMock,
  listenIfTauri: listenIfTauriMock,
}));

import type { PiRpcStartRequest } from "@/types";
import {
  abortPiRpcSession,
  getPiRpcSession,
  getPiRpcState,
  listPiRpcSessions,
  listenPiRpcEvents,
  PI_RPC_EVENT,
  PiRpcUnavailableError,
  promptPiRpcSession,
  startPiRpcSession,
  stopPiRpcSession,
} from "./piRpcService";

const startRequest = {
  launch: {
    projectPath: "C:/workspace/pi",
    cols: 120,
    rows: 40,
    cliTool: "pi",
    adapterOptions: { piTransport: "rpc" },
  },
  taskBindingId: "binding-1",
} satisfies PiRpcStartRequest;

const snapshot = {
  rpcSessionId: "rpc-1",
  phase: "idle" as const,
};

describe("piRpcService", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(snapshot);
    isTauriRuntimeMock.mockReset().mockReturnValue(true);
    listenIfTauriMock.mockReset().mockResolvedValue(() => {});
  });

  it("uses the declared desktop RPC commands and camelCase argument names", async () => {
    await startPiRpcSession(startRequest);
    await listPiRpcSessions();
    await getPiRpcSession("rpc-1");
    await promptPiRpcSession("rpc-1", "hello");
    await abortPiRpcSession("rpc-1");
    await getPiRpcState("rpc-1");
    await stopPiRpcSession("rpc-1");

    expect(invokeMock.mock.calls).toEqual([
      ["start_pi_rpc_session", { request: startRequest }],
      ["list_pi_rpc_sessions"],
      ["get_pi_rpc_session", { rpcSessionId: "rpc-1" }],
      ["prompt_pi_rpc_session", { rpcSessionId: "rpc-1", message: "hello" }],
      ["abort_pi_rpc_session", { rpcSessionId: "rpc-1" }],
      ["get_pi_rpc_state", { rpcSessionId: "rpc-1" }],
      ["stop_pi_rpc_session", { rpcSessionId: "rpc-1" }],
    ]);
  });

  it("fails closed outside the desktop runtime", async () => {
    isTauriRuntimeMock.mockReturnValue(false);

    await expect(listPiRpcSessions()).rejects.toBeInstanceOf(PiRpcUnavailableError);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("subscribes to structured Pi events on desktop", async () => {
    const handler = vi.fn();
    await listenPiRpcEvents(handler);

    expect(listenIfTauriMock).toHaveBeenCalledWith(PI_RPC_EVENT, expect.any(Function));
    const eventHandler = listenIfTauriMock.mock.calls[0][1];
    eventHandler({ payload: { rpcSessionId: "rpc-1", payload: { type: "agent_settled" } } });
    expect(handler).toHaveBeenCalledWith({
      rpcSessionId: "rpc-1",
      payload: { type: "agent_settled" },
    });
  });
});
