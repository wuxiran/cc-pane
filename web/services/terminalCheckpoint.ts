/**
 * 终端 checkpoint 上传与补拍请求订阅（M3b-2，.claude/plan-m3b-design.md §M3b-2）。
 *
 * 独立于 terminalService 的模块（该文件贴着行数棘轮基线）：
 *
 * - `uploadCheckpoint`：invokeOrApi 双模式上传照片。首个 `CHECKPOINT_UNSUPPORTED`
 *   （旧 daemon 无此路由 / 旧 app 无此命令）后 **capability 关断**，后续调用
 *   短路 no-op（防 18 标签同时边沿触发的探测风暴，见 M3b 风险表）。
 *   拒收（stale/gap/future/epoch/too-large）是**结果**不是错误，以
 *   `StoreCheckpointOutcome` 判别联合返回。
 *
 * - `registerCheckpointRequest`：订阅 daemon 补拍请求。事件链：daemon 30s 周期
 *   扫描 → control WS `checkpointRequest` → control link 转 WebView 事件
 *   `terminal-checkpoint-request`（EV::TERMINAL_CHECKPOINT_REQUEST）。
 *   **web 模式不注册**：浏览器端没有 control 通道，补拍请求到不了这里——
 *   best-effort 契约成立（daemon 周期重发，桌面端在场时响应）。
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { StoreCheckpointOutcome, TerminalCheckpointUpload } from "@/types";
import { getErrorCode } from "@/utils/errorTranslation";
import { invokeOrApi, isTauriRuntime } from "./apiClient";
import {
  addSubscriber,
  debugTerminalService,
  removeSubscriber,
} from "./terminalServiceShared";

// ── capability 缓存 ─────────────────────────────────────────

/** 首个 CHECKPOINT_UNSUPPORTED 后置真：旧后端没有 checkpoint 能力，别再探测。 */
let checkpointCapabilityDisabled = false;

/** 409 结构化拒收码 → 判别联合（与 daemon server.rs / daemon_client.rs 对齐）。 */
const REJECTION_BY_CODE: Record<string, StoreCheckpointOutcome> = {
  STALE_ANCHOR: { kind: "rejectedStaleAnchor" },
  ANCHOR_GAP: { kind: "rejectedAnchorGap" },
  FUTURE_ANCHOR: { kind: "rejectedFutureAnchor" },
  EPOCH_MISMATCH: { kind: "rejectedEpochMismatch" },
  TOO_LARGE: { kind: "rejectedTooLarge" },
};

/**
 * web 直连模式：POST /api/sessions/{id}/checkpoint。
 * 不走 apiJson——409 拒收要按结构化 code 映射成**结果**而不是异常，
 * 404/405 缺路由要能与「会话真不存在」（结构化 NOT_FOUND）区分开
 * （口径照抄 daemon_client.rs::upload_checkpoint）。
 */
async function uploadCheckpointViaApi(
  sessionId: string,
  checkpoint: TerminalCheckpointUpload,
): Promise<StoreCheckpointOutcome> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/checkpoint`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(checkpoint),
    },
  );
  if (response.ok) {
    const value = (await response.json()) as { anchorSeq?: number };
    return {
      kind: "accepted",
      anchorSeq: typeof value.anchorSeq === "number" ? value.anchorSeq : checkpoint.anchorSeq,
    };
  }
  const body = await response.text();
  let code: string | null = null;
  try {
    code = (JSON.parse(body) as { code?: string }).code ?? null;
  } catch {
    // 非 JSON body（如旧 daemon 的纯文本 404 页）
  }
  if (response.status === 409) {
    const rejection = code === null ? undefined : REJECTION_BY_CODE[code];
    if (rejection) return rejection;
    // SESSION_CLAIMED 等其他 409：不是拒收裁决，按错误上抛。
    throw new Error(body || `HTTP 409: checkpoint upload conflict`);
  }
  if (response.status === 404 || response.status === 405) {
    if (code === "NOT_FOUND") {
      // 新 daemon 的会话不存在（与旧 daemon 缺路由区分开）。
      throw new Error(`[NOT_FOUND] session not found for checkpoint upload: ${sessionId}`);
    }
    // getErrorCode 能解析 `[CODE] message` 前缀（REST 通道口径）。
    throw new Error(
      `[CHECKPOINT_UNSUPPORTED] daemon has no checkpoint endpoint (HTTP ${response.status})`,
    );
  }
  throw new Error(body || `HTTP ${response.status}: checkpoint upload failed`);
}

/**
 * 上传终端画面照片。返回 `null` 表示 capability 已关断（短路 no-op，
 * 调用方视同「本次没拍」）；拒收以判别联合返回，不抛异常。
 */
export async function uploadCheckpoint(
  sessionId: string,
  checkpoint: TerminalCheckpointUpload,
): Promise<StoreCheckpointOutcome | null> {
  if (checkpointCapabilityDisabled) return null;
  try {
    return await invokeOrApi<StoreCheckpointOutcome>(
      "upload_terminal_checkpoint",
      { sessionId, checkpoint },
      () => uploadCheckpointViaApi(sessionId, checkpoint),
    );
  } catch (error) {
    if (getErrorCode(error) === "CHECKPOINT_UNSUPPORTED") {
      checkpointCapabilityDisabled = true;
      debugTerminalService("checkpoint.capability.disabled", { sessionId });
      return null;
    }
    throw error;
  }
}

/** 测试用：恢复 capability 探测状态。 */
export function _resetCheckpointCapabilityForTest(): void {
  checkpointCapabilityDisabled = false;
}

// ── 补拍请求订阅（模式照 terminalService.registerDesync） ────

const checkpointRequestCallbacks = new Map<string, Set<() => void>>();
let requestListenerInitialized = false;
let unlistenCheckpointRequest: UnlistenFn | null = null;

async function ensureCheckpointRequestListener(): Promise<void> {
  if (requestListenerInitialized) return;
  requestListenerInitialized = true;
  // web 模式无 control 通道，事件永不到达——不注册（见模块头注释）。
  if (!isTauriRuntime()) return;
  unlistenCheckpointRequest = await getCurrentWebview().listen<{ sessionId: string }>(
    "terminal-checkpoint-request",
    (event) => {
      const set = checkpointRequestCallbacks.get(event.payload.sessionId);
      if (!set) return;
      for (const callback of set) callback();
    },
  );
}

/**
 * 注册 daemon 补拍请求回调（可多订阅）。返回 unsubscribe。
 * best-effort：回调丢了（无人订阅 / 会话未绑定）daemon 30s 周期扫描会重发。
 */
export async function registerCheckpointRequest(
  sessionId: string,
  callback: () => void,
): Promise<() => void> {
  await ensureCheckpointRequestListener();
  addSubscriber(checkpointRequestCallbacks, sessionId, callback);
  return () => {
    removeSubscriber(checkpointRequestCallbacks, sessionId, callback);
  };
}

/** 测试用：清空补拍请求订阅与监听器状态。 */
export function _resetCheckpointRequestForTest(): void {
  checkpointRequestCallbacks.clear();
  unlistenCheckpointRequest?.();
  unlistenCheckpointRequest = null;
  requestListenerInitialized = false;
}

// ── HMR 清理（开发模式） ──────────────────────────────────

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    checkpointRequestCallbacks.clear();
    unlistenCheckpointRequest?.();
    unlistenCheckpointRequest = null;
    requestListenerInitialized = false;
  });
}
