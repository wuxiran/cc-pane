import type { CreateSessionRequest, LaunchAdapterOptions } from "./terminal";

/** Pi RPC is a local background transport, never a terminal PTY session. */
export type PiRpcSessionPhase = "starting" | "idle" | "running" | "exited" | "failed";

/**
 * The RPC launcher shares the terminal request shape for provider/profile
 * resolution, while requiring Pi's structured transport and disallowing a
 * remote runtime.
 */
export type PiRpcLaunchRequest = Omit<
  CreateSessionRequest,
  "cliTool" | "adapterOptions" | "ssh" | "wsl"
> & {
  cliTool: "pi";
  adapterOptions: LaunchAdapterOptions & { piTransport: "rpc" };
  ssh?: never;
  wsl?: never;
};

export interface PiRpcStartRequest {
  launch: PiRpcLaunchRequest;
  taskBindingId?: string;
}

/** CC-Panes-owned identity, distinct from both Pi's session id and PTY ids. */
export interface PiRpcSessionSnapshot {
  rpcSessionId: string;
  phase: PiRpcSessionPhase;
  piSessionId?: string;
  sessionFile?: string;
  messageCount?: number;
  exitCode?: number;
  error?: string;
}

export interface PiRpcCommandResponse {
  id: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Raw Pi JSONL event relayed by the backend without a PTY attachment. */
export interface PiRpcEvent {
  rpcSessionId: string;
  payload: unknown;
}
