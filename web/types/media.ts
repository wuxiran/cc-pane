import type {
  CanvasMediaKind,
  CanvasMediaOperation,
  CanvasMediaProbeStatus,
  CanvasMediaProjection,
  CanvasMediaRunStatus,
  CanvasMediaSubtype,
  CanvasNodeProjection,
  CanvasStoryboardShot,
} from "./canvas";

export type MediaKind = CanvasMediaKind;
export type MediaOperation = CanvasMediaOperation;
export type MediaRunStatus = CanvasMediaRunStatus;
export type MediaNodeSubtype = CanvasMediaSubtype;
export type MediaStoryboardShot = CanvasStoryboardShot;
export type MediaProtocol = "open_ai_compatible" | "sub2api" | "comfyui";
export type MediaCachePolicy = "read_write" | "bypass" | "refresh";

/**
 * The workspace/project pair is the durable root scope for both media modes.
 * `projectPath` is display/context metadata only; the backend resolves the
 * trusted path from the workspace registry before touching the filesystem.
 */
export interface MediaScope {
  workspaceId: string;
  projectId: string;
  projectPath?: string | null;
}

/**
 * A named media Canvas is a view over one durable media graph.  The graph
 * itself remains keyed by `workspaceId + layoutId` in the backend; this
 * client-side record gives users a stable, selectable space in which to work.
 */
export type MediaCanvasScope = "workspace" | "project";

export interface MediaCanvasSpace {
  id: string;
  name: string;
  workspaceId: string;
  /** A project Canvas is pinned to one project; workspace Canvases are shared. */
  projectId: string | null;
  scope: MediaCanvasScope;
  layoutId: string;
  createdAt: string;
}

export const MEDIA_SCOPE_PARAMETER = "mediaScope" as const;

/**
 * Reserved key inside `MediaNode.parameters` marking a non-generation node.
 * The durable `kind` column stays `image` (the SQLite CHECK is closed), so
 * subtype nodes ride on the existing table without a schema migration.
 */
export const MEDIA_NODE_SUBTYPE_PARAMETER = "nodeSubtype" as const;

export const MEDIA_NODE_SUBTYPES: readonly MediaNodeSubtype[] = ["text", "script", "audio", "board", "storyboard"];

/** Read the subtype marker out of durable node parameters, if present. */
export function mediaNodeSubtype(parameters: Record<string, unknown> | null | undefined): MediaNodeSubtype | undefined {
  const value = parameters?.[MEDIA_NODE_SUBTYPE_PARAMETER];
  return typeof value === "string" && (MEDIA_NODE_SUBTYPES as readonly string[]).includes(value)
    ? value as MediaNodeSubtype
    : undefined;
}

/** Normalize the persisted storyboard cells; tolerates malformed entries. */
export function mediaStoryboardShots(parameters: Record<string, unknown> | null | undefined): MediaStoryboardShot[] {
  const raw = parameters?.shots;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const shot = entry as Record<string, unknown>;
    if (typeof shot.id !== "string" || !shot.id) return [];
    return [{
      id: shot.id,
      title: typeof shot.title === "string" ? shot.title : undefined,
      prompt: typeof shot.prompt === "string" ? shot.prompt : undefined,
      generatedNodeId: typeof shot.generatedNodeId === "string" ? shot.generatedNodeId : undefined,
      previewUrl: typeof shot.previewUrl === "string" ? shot.previewUrl : undefined,
    }];
  });
}

/** Normalized capabilities exposed by the selected media adapter. */
export interface MediaProviderCapabilities {
  providerId: string;
  protocol: string;
  kinds: MediaKind[];
  operations: MediaOperation[];
  supportsAsyncJobs: boolean;
  supportsCancel: boolean;
}

export interface MediaProviderRef {
  providerId: string;
  modelId: string;
}

export interface MediaNode {
  id: string;
  workspaceId: string;
  layoutId: string;
  kind: MediaKind;
  title: string;
  defaultOperation: MediaOperation;
  providerRef?: MediaProviderRef | null;
  parameters: Record<string, unknown>;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaRun {
  id: string;
  nodeId: string;
  operation: MediaOperation;
  status: MediaRunStatus;
  attempt: number;
  priority: number;
  cachePolicy: MediaCachePolicy;
  clientRequestId?: string | null;
  providerRef?: MediaProviderRef | null;
  request: Record<string, unknown>;
  remoteJobId?: string | null;
  progress?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  executionFingerprint?: string | null;
  cacheHit: boolean;
  inputAssetIds: string[];
  outputAssetIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MediaAsset {
  id: string;
  workspaceId: string;
  runId?: string | null;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * A previously generated, app-owned media asset selected as the input for a
 * new generation. This stays UI-only: the server still receives the validated
 * `assetId`, while the source identifiers let the Studio create an immutable
 * Canvas edge after the downstream node exists.
 */
export interface MediaInputAssetSelection {
  assetId: string;
  sourceNodeId: string;
  sourceRunId: string;
  mediaKind: MediaKind;
  name: string;
  mimeType: string;
}

export interface MediaEdge {
  id: string;
  workspaceId: string;
  layoutId: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  selector: "latestSucceeded" | "specificAsset";
  assetId?: string | null;
  createdAt: string;
}

export interface CreateMediaRunRequest {
  nodeId: string;
  operation: MediaOperation;
  request: Record<string, unknown>;
  clientRequestId?: string;
  inputAssetIds?: string[];
  priority?: number;
  cachePolicy?: MediaCachePolicy;
}

export interface ReplayMediaRunRequest {
  prompt?: string;
  parameters?: Record<string, unknown>;
  inputAssetIds?: string[];
  priority?: number;
  cachePolicy?: MediaCachePolicy;
  clientRequestId?: string;
}

export interface MediaQueueSnapshot {
  queued: number;
  active: number;
  succeeded: number;
  failed: number;
  canceled: number;
  highestPriority?: number | null;
  oldestQueuedAt?: string | null;
  sampledAt: string;
}

export interface MediaResourceSnapshot {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  freeMemoryBytes: number;
  gpuFreeBytes?: number | null;
  gpuTotalBytes?: number | null;
  sampledAt: string;
}

export interface MediaSchedulerSnapshot {
  queue: MediaQueueSnapshot;
  activeWorkers: number;
  maxConcurrent: number;
  owner: string;
  resource: MediaResourceSnapshot;
}

export function isMediaMimeCompatible(kind: MediaKind, mimeType: string | null | undefined): boolean {
  if (!mimeType?.trim()) return true;
  const normalized = mimeType.trim().toLowerCase();
  return kind === "image" ? normalized.startsWith("image/") : normalized.startsWith("video/");
}

export function isMediaPreviewUrl(value: string | undefined): value is string {
  const candidate = value?.trim();
  if (!candidate) return false;
  try {
    const base = typeof window !== "undefined" ? window.location.href : "http://canvas.invalid/";
    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
      if (!(candidate.startsWith("/") || candidate.startsWith("./") || candidate.startsWith("../"))) return false;
      const parsedRelative = new URL(candidate, base);
      return typeof window !== "undefined" && parsedRelative.origin === window.location.origin;
    }
    const parsed = new URL(candidate, base);
    if (parsed.protocol === "data:") return /^data:(image|video)\//i.test(candidate);
    if (["asset:", "blob:"].includes(parsed.protocol)) return true;
    // Windows Tauri serves the configured asset protocol through the
    // `asset.localhost` HTTP origin; it is still an app-owned URL, unlike a
    // provider URL that must never be rendered directly.
    if (parsed.protocol === "http:" && parsed.hostname === "asset.localhost") return true;
    // Provider URLs are never rendered directly. The backend downloads and
    // validates assets first; only same-origin API/asset paths are accepted by
    // the Canvas projection.
    return ["http:", "https:"].includes(parsed.protocol)
      && typeof window !== "undefined"
      && parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Convert persisted media state to the existing Canvas node contract. */
export function toCanvasMediaNode(
  node: MediaNode,
  run?: MediaRun,
  previewAsset?: MediaAsset,
): CanvasNodeProjection {
  const subtype = mediaNodeSubtype(node.parameters);
  if (subtype) {
    // Subtype nodes never run generations themselves; they carry authored
    // content (text, audio reference, storyboard cells) on the durable graph.
    const media: CanvasMediaProjection = {
      mediaKind: node.kind,
      subtype,
      contentText: typeof node.parameters.contentText === "string" ? node.parameters.contentText : undefined,
      audioSource: typeof node.parameters.audioSource === "string" ? node.parameters.audioSource : undefined,
      shots: subtype === "storyboard" ? mediaStoryboardShots(node.parameters) : undefined,
      nodeParameters: node.parameters,
      alt: node.title,
      capabilities: { supportedOperations: [], canRun: false, canCancel: false, canRetry: false },
    };
    return {
      id: `media:${node.id}`,
      label: node.title,
      kind: "media",
      status: "idle",
      layoutId: node.layoutId,
      media,
    };
  }
  const runStatus = run?.status;
  const status = runStatus === "succeeded"
    ? "completed"
    : runStatus === "failed" || runStatus === "canceled"
      ? "failed"
      : runStatus
        ? "running"
        : "idle";
  const metadata = previewAsset?.metadata ?? {};
  const metadataUrls = [metadata.previewUrl, metadata.url]
    .filter((value): value is string => typeof value === "string");
  const relativeUrl = previewAsset?.relativePath;
  const compatible = isMediaMimeCompatible(node.kind, previewAsset?.mimeType);
  const previewUrl = compatible
    ? metadataUrls.find(isMediaPreviewUrl)
      ?? (isMediaPreviewUrl(relativeUrl) ? relativeUrl : undefined)
    : undefined;
  const posterCandidate = typeof metadata.posterUrl === "string" ? metadata.posterUrl : undefined;
  const posterUrl = node.kind === "video" && posterCandidate && isMediaPreviewUrl(posterCandidate)
    ? posterCandidate
    : undefined;
  const supportedOperations = node.kind === "image"
    ? ["textToImage", "imageToImage", "edit", "upscale"] as const
    : ["textToVideo", "imageToVideo", "edit", "extend"] as const;
  const activeRun = runStatus === "queued"
    || runStatus === "submitting"
    || runStatus === "processing"
    || runStatus === "downloading"
    || runStatus === "canceling";
  const media: CanvasMediaProjection = {
    mediaKind: node.kind,
    operation: run?.operation ?? node.defaultOperation,
    runStatus: runStatus ?? "queued",
    previewUrl,
    posterUrl,
    assetId: previewAsset?.id,
    progress: run?.progress ?? undefined,
    runId: run?.id,
    cacheHit: run?.cacheHit ?? false,
    priority: run?.priority ?? 0,
    updatedAt: run?.updatedAt,
    mimeType: previewAsset?.mimeType,
    width: previewAsset?.width ?? undefined,
    height: previewAsset?.height ?? undefined,
    durationMs: previewAsset?.durationMs ?? undefined,
    fps: numberMetadata(metadata, ["fps", "frameRate", "frame_rate"]),
    frameCount: numberMetadata(metadata, ["frameCount", "frame_count", "frames"]),
    codec: stringMetadata(metadata, ["codec", "videoCodec", "video_codec"]),
    container: stringMetadata(metadata, ["container", "format", "formatName", "format_name"]),
    audio: booleanMetadata(metadata, ["audio", "hasAudio", "has_audio"]),
    audioCodec: stringMetadata(metadata, ["audioCodec", "audio_codec"]),
    audioChannels: numberMetadata(metadata, ["audioChannels", "audio_channels"]),
    sampleRate: numberMetadata(metadata, ["sampleRate", "sample_rate"]),
    colorSpace: stringMetadata(metadata, ["colorSpace", "color_space", "colorspace"]),
    colorTransfer: stringMetadata(metadata, ["colorTransfer", "color_transfer"]),
    colorPrimaries: stringMetadata(metadata, ["colorPrimaries", "color_primaries"]),
    pixelFormat: stringMetadata(metadata, ["pixelFormat", "pixel_format", "pix_fmt"]),
    bitDepth: numberMetadata(metadata, ["bitDepth", "bit_depth"]),
    probeStatus: probeStatusMetadata(metadata),
    probeReason: stringMetadata(metadata, ["probeReason"]),
    alt: node.title,
    errorCode: run?.errorCode ?? undefined,
    errorMessage: run?.errorMessage ?? undefined,
    capabilities: {
      supportedOperations: [...supportedOperations],
      canRun: !activeRun,
      canCancel: activeRun && runStatus !== "canceling",
      canRetry: runStatus === "failed" || runStatus === "canceled",
    },
  };
  return {
    id: `media:${node.id}`,
    label: node.title,
    kind: "media",
    status,
    layoutId: node.layoutId,
    media,
  };
}

function numberMetadata(metadata: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = metadata[key];
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function stringMetadata(metadata: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.slice(0, 128);
  }
  return undefined;
}

function booleanMetadata(metadata: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (["true", "yes", "1"].includes(value.toLowerCase())) return true;
      if (["false", "no", "0"].includes(value.toLowerCase())) return false;
    }
  }
  return undefined;
}

function probeStatusMetadata(metadata: Record<string, unknown>): CanvasMediaProbeStatus | undefined {
  const value = metadata.probeStatus;
  if (typeof value !== "string") return undefined;
  return ["ok", "skipped", "unavailable", "timeout", "output_limit", "failed", "invalid"].includes(value)
    ? value as CanvasMediaProbeStatus
    : undefined;
}

export type {
  ComfyInputSpec,
  ComfyNodeInputGroups,
  ComfyNodeDefinition,
  ComfyNodeBranch,
  ComfyObjectInfoResponse,
  ComfySystemInfo,
  ComfyDeviceInfo,
  ComfySystemStats,
  ComfyMemoryReleaseResult,
  ComfyWorkflowNode,
  ComfyWorkflow,
} from "./mediaComfy";
export {
  COMFY_OBJECT_INFO_SCHEMA_VERSION,
  COMFY_WORKFLOW_SCHEMA_VERSION,
  classifyComfyNode,
  parseComfyWorkflow,
  canonicalizeJson,
  jsonFingerprint,
} from "./mediaComfy";
