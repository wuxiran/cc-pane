// 设置 → 设备与访问：网页登录会话、撤销其他全部、编排器令牌更换、Tailscale Serve 一键开关。
// 桌面端经 Tauri 命令；Web 端只有网页会话三项有对应路由（/api/auth/*），其余为桌面专属。
import { apiDeleteJson, apiGet, apiJson, invokeOrApi } from "./apiClient";

const DESKTOP_ONLY = () => Promise.reject(new Error("Only available in the desktop app"));

/** 更换编排器令牌后广播：展示令牌的卡片据此重新读取。 */
export const ORCHESTRATOR_TOKEN_ROTATED_EVENT = "ccpanes:orchestrator-token-rotated";

export interface WebSessionInfo {
  /** cookie 的 SHA-256：可用来注销，不能用来登录 */
  id: string;
  createdAt: string;
  lastActivityAt: string;
  ip: string | null;
  userAgent: string | null;
  /** 发起本次查询的会话（桌面端查询时恒为 false） */
  current: boolean;
}

export interface WebSessionList {
  webRunning: boolean;
  sessions: WebSessionInfo[];
}

export interface RevokeOthersResult {
  deviceTokens: number;
  webSessions: number;
}

export interface OrchestratorRotationImpact {
  runningSessions: number;
}

export interface TailscaleServeStatus {
  active: boolean;
  url: string | null;
}

export type TailscaleServeError =
  | { kind: "notInstalled" }
  | { kind: "notRunning"; backendState: string | null }
  | { kind: "needsApproval"; url: string | null }
  | { kind: "permissionDenied"; detail: string }
  | { kind: "passwordRequired" }
  | { kind: "failed"; detail: string };

export interface TailscaleServeOutcome {
  status: TailscaleServeStatus | null;
  error: TailscaleServeError | null;
}

export function listWebSessions(): Promise<WebSessionList> {
  return invokeOrApi<WebSessionList>("web_sessions_list", undefined, async () => {
    const body = await apiGet<{ sessions: WebSessionInfo[] }>("/api/auth/sessions");
    return { webRunning: true, sessions: body.sessions };
  });
}

export function revokeWebSession(id: string): Promise<void> {
  return invokeOrApi<void>("web_session_revoke", { id }, async () => {
    await apiDeleteJson<unknown>(`/api/auth/sessions/${encodeURIComponent(id)}`);
  });
}

/** 撤销除调用方以外的全部设备令牌与网页登录会话。 */
export function revokeOtherAccess(): Promise<RevokeOthersResult> {
  return invokeOrApi<RevokeOthersResult>("device_access_revoke_others", undefined, () =>
    apiJson<RevokeOthersResult>("/api/auth/revoke-others", "POST", {}),
  );
}

export function getOrchestratorRotationImpact(): Promise<OrchestratorRotationImpact> {
  return invokeOrApi<OrchestratorRotationImpact>("orchestrator_rotation_impact", undefined, DESKTOP_ONLY);
}

export async function rotateOrchestratorToken(): Promise<void> {
  await invokeOrApi<void>("rotate_orchestrator_token", undefined, DESKTOP_ONLY);
  window.dispatchEvent(new Event(ORCHESTRATOR_TOKEN_ROTATED_EVENT));
}

export function getTailscaleServeStatus(): Promise<TailscaleServeOutcome> {
  return invokeOrApi<TailscaleServeOutcome>("tailscale_serve_get_status", undefined, DESKTOP_ONLY);
}

export function startTailscaleServe(): Promise<TailscaleServeOutcome> {
  return invokeOrApi<TailscaleServeOutcome>("tailscale_serve_start", undefined, DESKTOP_ONLY);
}

export function stopTailscaleServe(): Promise<TailscaleServeOutcome> {
  return invokeOrApi<TailscaleServeOutcome>("tailscale_serve_stop", undefined, DESKTOP_ONLY);
}
