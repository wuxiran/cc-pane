import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime, listenIfTauri } from "./runtime";
import type {
  PiRpcCommandResponse,
  PiRpcEvent,
  PiRpcSessionSnapshot,
  PiRpcStartRequest,
} from "@/types";

export const PI_RPC_EVENT = "pi-rpc-event";

export class PiRpcUnavailableError extends Error {
  readonly code = "UNAVAILABLE";

  constructor() {
    super("Pi RPC is only available in the desktop app");
  }
}

function requireDesktop(): void {
  if (!isTauriRuntime()) throw new PiRpcUnavailableError();
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  requireDesktop();
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
}

export type PiRpcEventHandler = (event: PiRpcEvent) => void | Promise<void>;

export function startPiRpcSession(request: PiRpcStartRequest): Promise<PiRpcSessionSnapshot> {
  return call("start_pi_rpc_session", { request });
}

export function listPiRpcSessions(): Promise<PiRpcSessionSnapshot[]> {
  return call("list_pi_rpc_sessions");
}

export function getPiRpcSession(rpcSessionId: string): Promise<PiRpcSessionSnapshot> {
  return call("get_pi_rpc_session", { rpcSessionId });
}

export function promptPiRpcSession(
  rpcSessionId: string,
  message: string,
): Promise<PiRpcCommandResponse> {
  return call("prompt_pi_rpc_session", { rpcSessionId, message });
}

export function abortPiRpcSession(rpcSessionId: string): Promise<PiRpcCommandResponse> {
  return call("abort_pi_rpc_session", { rpcSessionId });
}

export function getPiRpcState(rpcSessionId: string): Promise<PiRpcCommandResponse> {
  return call("get_pi_rpc_state", { rpcSessionId });
}

export function stopPiRpcSession(rpcSessionId: string): Promise<PiRpcSessionSnapshot> {
  return call("stop_pi_rpc_session", { rpcSessionId });
}

export async function listenPiRpcEvents(handler: PiRpcEventHandler): Promise<UnlistenFn> {
  requireDesktop();
  return listenIfTauri<PiRpcEvent>(PI_RPC_EVENT, (event) => handler(event.payload));
}

/** Structured Pi background transport. Do not use this for terminal launches. */
export const piRpcService = {
  start: startPiRpcSession,
  list: listPiRpcSessions,
  get: getPiRpcSession,
  prompt: promptPiRpcSession,
  abort: abortPiRpcSession,
  getState: getPiRpcState,
  stop: stopPiRpcSession,
  listen: listenPiRpcEvents,
};
