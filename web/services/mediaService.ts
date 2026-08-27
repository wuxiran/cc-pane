import type {
  CreateMediaRunRequest,
  ComfyObjectInfoResponse,
  ComfyMemoryReleaseResult,
  ComfySystemStats,
  MediaAsset,
  MediaEdge,
  MediaNode,
  MediaRun,
  MediaRunStatus,
  MediaQueueSnapshot,
  MediaProviderCapabilities,
  MediaSchedulerSnapshot,
  ReplayMediaRunRequest,
  MediaScope,
} from "@/types";
import { apiDelete, apiGet, apiJson, invokeOrApi } from "./apiClient";
import { isTauriRuntime, listenWebviewIfTauri } from "./runtime";

export interface MediaJobChangedEvent {
  type?: "media-job-changed";
  workspaceId?: string | null;
  runId: string;
  nodeId: string;
  status: string;
  progress?: number;
  assetIds?: string[];
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface ComfyRuntimeStatus {
  enabled: boolean;
  running: boolean;
  pid?: number | null;
  port: number;
  baseUrl: string;
  root?: string | null;
  python?: string | null;
  startupError?: string | null;
  ready?: boolean;
  readiness?: "stopped" | "starting" | "ready" | string;
  readinessError?: string | null;
  stderr?: string | null;
}

export interface CreateMediaNodeRequest {
  workspaceId: string;
  layoutId: string;
  kind: "image" | "video";
  title: string;
  defaultOperation?: string;
  providerRef?: { providerId: string; modelId: string };
  parameters?: Record<string, unknown>;
  /** Scope is also persisted inside parameters for older API clients. */
  mediaScope?: MediaScope;
}

export interface MediaEdgeRequest {
  workspaceId: string;
  layoutId: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  selector?: "latestSucceeded" | "specificAsset";
  assetId?: string;
}

export interface StageMediaInputRequest {
  workspaceId: string;
  filename: string;
  mimeType: string;
  data: string;
  metadata?: Record<string, unknown>;
  mediaScope?: MediaScope;
}

export const mediaService = {
  getProviderCapabilities(
    providerId: string,
    protocol: string,
  ): Promise<MediaProviderCapabilities> {
    const query = { providerId, protocol };
    return invokeOrApi(
      "get_media_provider_capabilities",
      query,
      () => apiGet("/api/media/capabilities", query),
    );
  },

  getComfyObjectInfo(
    providerId: string,
    classType?: string,
    refresh = false,
  ): Promise<ComfyObjectInfoResponse> {
    const query = { providerId, classType, refresh };
    return invokeOrApi(
      "get_comfy_object_info",
      query,
      () => apiGet("/api/media/comfy/object-info", query),
    );
  },

  getComfySystemStats(providerId: string): Promise<ComfySystemStats> {
    return invokeOrApi(
      "get_comfy_system_stats",
      { providerId },
      () => apiGet("/api/media/comfy/system-stats", { providerId }),
    );
  },

  freeComfyMemory(
    providerId: string,
    options: { unloadModels?: boolean; freeMemory?: boolean } = {},
  ): Promise<ComfyMemoryReleaseResult> {
    const request = {
      providerId,
      unloadModels: options.unloadModels ?? false,
      freeMemory: options.freeMemory ?? true,
    };
    return invokeOrApi(
      "free_comfy_memory",
      request,
      () => apiJson("/api/media/comfy/free", "POST", request),
    );
  },

  getComfyRuntimeStatus(): Promise<ComfyRuntimeStatus> {
    return invokeOrApi("get_comfy_runtime_status", {}, () => apiGet("/api/comfy/runtime/status"));
  },

  startComfyRuntime(): Promise<ComfyRuntimeStatus> {
    return invokeOrApi("start_comfy_runtime", {}, () => apiJson("/api/comfy/runtime/start", "POST"));
  },

  stopComfyRuntime(): Promise<ComfyRuntimeStatus> {
    return invokeOrApi("stop_comfy_runtime", {}, () => apiJson("/api/comfy/runtime/stop", "POST"));
  },

  restartComfyRuntime(): Promise<ComfyRuntimeStatus> {
    return invokeOrApi("restart_comfy_runtime", {}, () => apiJson("/api/comfy/runtime/restart", "POST"));
  },

  listNodes(workspaceId: string, layoutId?: string): Promise<MediaNode[]> {
    const query = { workspaceId, layoutId, includeDeleted: false };
    return invokeOrApi("list_media_nodes", query, () => apiGet("/api/media/nodes", query));
  },

  createNode(request: CreateMediaNodeRequest): Promise<MediaNode> {
    return invokeOrApi("create_media_node", { request }, () => apiJson("/api/media/nodes", "POST", request));
  },

  updateNode(nodeId: string, request: Partial<CreateMediaNodeRequest>): Promise<MediaNode> {
    return invokeOrApi("update_media_node", { nodeId, request }, () => apiJson(`/api/media/nodes/${encodeURIComponent(nodeId)}`, "PUT", request));
  },

  deleteNode(nodeId: string): Promise<boolean> {
    return invokeOrApi("delete_media_node", { nodeId }, async () => {
      await apiDelete(`/api/media/nodes/${encodeURIComponent(nodeId)}`);
      return true;
    });
  },

  createRun(request: CreateMediaRunRequest): Promise<MediaRun> {
    return invokeOrApi("create_media_run", { request }, () => apiJson("/api/media/runs", "POST", request));
  },

  listRuns(nodeId: string, limit = 20): Promise<MediaRun[]> {
    const query = { nodeId, limit, offset: 0 };
    return invokeOrApi("list_media_runs", query, () => apiGet("/api/media/runs", query));
  },

  getRun(runId: string): Promise<MediaRun | null> {
    return invokeOrApi("get_media_run", { runId }, () => apiGet(`/api/media/runs/${encodeURIComponent(runId)}`));
  },

  cancelRun(runId: string): Promise<MediaRun> {
    return invokeOrApi("cancel_media_run", { runId }, () => apiJson(`/api/media/runs/${encodeURIComponent(runId)}/cancel`, "POST"));
  },

  retryRun(runId: string): Promise<MediaRun> {
    return invokeOrApi("retry_media_run", { runId }, () => apiJson(`/api/media/runs/${encodeURIComponent(runId)}/retry`, "POST"));
  },

  replayRun(runId: string, request: ReplayMediaRunRequest = {}): Promise<MediaRun> {
    const payload = { ...request, clientRequestId: request.clientRequestId ?? crypto.randomUUID() };
    return invokeOrApi(
      "replay_media_run",
      { runId, request: payload },
      () => apiJson(`/api/media/runs/${encodeURIComponent(runId)}/replay`, "POST", payload),
    );
  },

  setPriority(runId: string, priority: number): Promise<MediaRun> {
    return invokeOrApi(
      "set_media_run_priority",
      { runId, priority },
      () => apiJson(`/api/media/runs/${encodeURIComponent(runId)}/priority`, "POST", { priority }),
    );
  },

  getQueueSnapshot(): Promise<MediaQueueSnapshot> {
    return invokeOrApi(
      "get_media_queue_snapshot",
      {},
      () => apiGet("/api/media/queue"),
    );
  },

  getSchedulerSnapshot(): Promise<MediaSchedulerSnapshot> {
    if (isTauriRuntime()) {
      return invokeOrApi("get_media_scheduler_snapshot", {}, () => apiGet("/api/media/scheduler"));
    }
    // The web worker owns the same durable queue, but is intentionally kept
    // out of AppState so route test fixtures do not need a runtime handle.
    // Build a truthful queue-backed projection until a dedicated scheduler
    // endpoint is available; resource values are explicitly unknown (zero).
    return apiGet<MediaQueueSnapshot>("/api/media/queue").then((queue) => ({
      queue,
      activeWorkers: queue.active,
      maxConcurrent: Math.max(1, queue.active),
      owner: "web",
      resource: {
        cpuPercent: 0,
        memoryUsedBytes: 0,
        memoryTotalBytes: 0,
        freeMemoryBytes: 0,
        sampledAt: queue.sampledAt,
      },
    }));
  },

  transitionRun(
    runId: string,
    status: MediaRunStatus,
    progress?: number,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<MediaRun> {
    const request = { status, progress, errorCode, errorMessage };
    return invokeOrApi("transition_media_run", { runId, ...request }, () => apiJson(`/api/media/runs/${encodeURIComponent(runId)}/transition`, "POST", request));
  },

  listAssets(workspaceId: string, runId?: string): Promise<MediaAsset[]> {
    const query = { workspaceId, runId };
    return invokeOrApi("list_media_assets", query, () => apiGet("/api/media/assets", query));
  },

  stageInput(request: StageMediaInputRequest): Promise<MediaAsset> {
    return invokeOrApi("stage_media_input", { request }, () => apiJson("/api/media/assets/stage", "POST", request));
  },

  resolveAssetUrl(assetId: string): Promise<string> {
    return invokeOrApi(
      "resolve_media_asset",
      { assetId },
      async () => `/api/media/assets/${encodeURIComponent(assetId)}/content`,
    );
  },

  listen(handler: (event: MediaJobChangedEvent) => void, workspaceId?: string | null): Promise<() => void> {
    if (isTauriRuntime()) {
      return listenWebviewIfTauri<MediaJobChangedEvent>("media-job-changed", (event) => {
        const payload = event.payload;
        if (workspaceId && payload.workspaceId && payload.workspaceId !== workspaceId) return;
        handler(payload);
      });
    }

    // The web daemon exposes a cookie-authenticated, server-to-client stream.
    // Events are hints only: the Canvas always follows them with a REST refresh
    // and keeps its polling fallback when this socket is unavailable.
    if (typeof window === "undefined" || typeof WebSocket === "undefined") {
      return Promise.resolve(() => {});
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = workspaceId
      ? `?${new URLSearchParams({ workspaceId }).toString()}`
      : "";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/media${query}`);
    let closed = false;
    socket.onmessage = (message) => {
      if (closed) return;
      try {
        const parsed: unknown = JSON.parse(typeof message.data === "string" ? message.data : "");
        if (!parsed || typeof parsed !== "object") return;
        const payload = parsed as Partial<MediaJobChangedEvent>;
        if (payload.type && payload.type !== "media-job-changed") return;
        if (typeof payload.runId !== "string" || typeof payload.nodeId !== "string" || typeof payload.status !== "string") return;
        if (workspaceId && payload.workspaceId && payload.workspaceId !== workspaceId) return;
        handler({
          ...payload,
          runId: payload.runId,
          nodeId: payload.nodeId,
          status: payload.status,
        });
      } catch {
        // Malformed or non-event frames are ignored; the next poll remains
        // authoritative and prevents a broken stream from breaking Canvas.
      }
    };
    socket.onerror = () => {
      // REST polling is the recovery path. Avoid surfacing a transient socket
      // error as a media generation failure.
    };
    return Promise.resolve(() => {
      closed = true;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    });
  },

  listEdges(workspaceId: string, layoutId?: string): Promise<MediaEdge[]> {
    const query = { workspaceId, layoutId };
    return invokeOrApi("list_media_edges", query, () => apiGet("/api/media/edges", query));
  },

  createEdge(request: MediaEdgeRequest): Promise<MediaEdge> {
    return invokeOrApi("create_media_edge", { request }, () => apiJson("/api/media/edges", "POST", request));
  },
};
