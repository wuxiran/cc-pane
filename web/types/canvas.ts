import type { PaneNode, TaskBinding } from "@/types";

export type CanvasDisplayMode = "panel" | "canvas";
export type NodeVisualState = "pending" | "running" | "waiting" | "completed" | "failed" | "idle" | "offline";
export type PipeEventKind = "dispatch" | "message" | "report";
export type PipeEventPhase = "queued" | "flowing" | "delivered" | "failed";
export type CanvasMediaKind = "image" | "video";
export type CanvasMediaOperation =
  | "textToImage"
  | "imageToImage"
  | "textToVideo"
  | "imageToVideo"
  | "edit"
  | "upscale"
  | "extend";
export type CanvasMediaRunStatus =
  | "queued"
  | "submitting"
  | "processing"
  | "downloading"
  | "canceling"
  | "succeeded"
  | "failed"
  | "canceled";
export type CanvasMediaProbeStatus =
  | "ok"
  | "skipped"
  | "unavailable"
  | "timeout"
  | "output_limit"
  | "failed"
  | "invalid";

export interface CanvasMediaCapabilities {
  /** Operations valid for this node's output kind. */
  supportedOperations: CanvasMediaOperation[];
  canRun: boolean;
  canCancel: boolean;
  canRetry: boolean;
}

/** Runtime media state projected into a Canvas node. */
export interface CanvasMediaProjection {
  mediaKind: CanvasMediaKind;
  operation?: CanvasMediaOperation;
  runStatus?: CanvasMediaRunStatus;
  previewUrl?: string;
  posterUrl?: string;
  assetId?: string;
  progress?: number;
  runId?: string;
  cacheHit?: boolean;
  priority?: number;
  updatedAt?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  fps?: number;
  frameCount?: number;
  codec?: string;
  container?: string;
  audio?: boolean;
  audioCodec?: string;
  audioChannels?: number;
  sampleRate?: number;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
  pixelFormat?: string;
  bitDepth?: number;
  probeStatus?: CanvasMediaProbeStatus;
  probeReason?: string;
  alt?: string;
  errorCode?: string;
  errorMessage?: string;
  capabilities?: CanvasMediaCapabilities;
}

/** Durable media-to-media link projected into the graph layer. */
export interface CanvasMediaEdgeProjection {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourcePort?: string;
  targetPort?: string;
}

export interface CanvasNodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasNodeProjection {
  id: string;
  label: string;
  kind: "task" | "terminal" | "media";
  /** Present only for media nodes; media content is rendered with DOM media elements. */
  media?: CanvasMediaProjection;
  /** Project metadata is used only to render an attach-only terminal mirror. */
  projectPath?: string;
  workspaceName?: string;
  cliTool?: string;
  role?: "task" | "leader" | "worker";
  bindingId?: string;
  sessionId?: string;
  paneId?: string;
  tabId?: string;
  /** Parent tab fallback for sessions launched before TaskBinding is linked. */
  parentTabId?: string;
  /** Parent session fallback when a binding has not been attached to a tab yet. */
  parentSessionId?: string;
  leafId?: string;
  layoutId?: string;
  parentId?: string;
  status: NodeVisualState;
  progress?: number;
  position?: CanvasNodePosition;
}

export interface CanvasSnapshotScope {
  workspaceId: string | null;
  layoutId: string;
}

/**
 * Durable Canvas v2 snapshots contain only user-authored geometry. Runtime
 * node metadata (including media URLs and run state) is re-projected from the
 * database when the Canvas opens.
 */
export interface CanvasSnapshotNode {
  id: string;
  position: CanvasNodePosition;
}

interface CanvasSnapshotBase {
  workspaceId: string | null;
  layoutId: string;
  savedAt: string;
  displayMode: CanvasDisplayMode;
  animationIntensity: "off" | "reduced" | "full";
  customizedNodeIds?: string[];
}

/** Legacy v1 shape retained so existing localStorage snapshots can be read. */
export interface CanvasSnapshotV1 extends CanvasSnapshotBase {
  version: 1;
  nodes: CanvasNodeProjection[];
}

/** Current shape: nodes are stable ids and explicit positions only. */
export interface CanvasSnapshotV2 extends CanvasSnapshotBase {
  version: 2;
  nodes: CanvasSnapshotNode[];
}

export type CanvasSnapshot = CanvasSnapshotV1 | CanvasSnapshotV2;

/** Input accepted by the store while callers migrate from the v1 API. */
export interface CanvasSnapshotPatch {
  savedAt?: string;
  displayMode?: CanvasDisplayMode;
  animationIntensity?: "off" | "reduced" | "full";
  nodes?: Array<CanvasNodeProjection | CanvasSnapshotNode>;
  customizedNodeIds?: string[];
}

export interface PipeEdge {
  id: string;
  sourceId: string;
  targetId: string;
  readOnly: true;
}

/** Rust orchestration-pipe-event wire contract. */
export interface PipeEventWire {
  schemaVersion: number;
  eventId: string;
  correlationId: string;
  attempt?: number;
  sequence: number;
  workspaceId: string;
  kind: PipeEventKind;
  phase: PipeEventPhase;
  fromBinding?: string;
  toBinding?: string;
  fromSession?: string;
  toSession?: string;
  summary: string;
  reason?: string;
  createdAt: string;
}

/** Validated event consumed by Canvas state and rendering. */
export interface CanvasPipeEvent extends PipeEventWire {
  sourceId?: string;
  targetId?: string;
}

export type PipeEvent = CanvasPipeEvent;

export interface CanvasProjectionInput {
  bindings: TaskBinding[];
  layouts: Array<{ id: string; rootPane: PaneNode; kind?: string }>;
  /** Only project nodes assigned to this normal layout when provided. */
  layoutId?: string;
  /** Durable media nodes supplied by the media runtime. */
  mediaNodes?: CanvasNodeProjection[];
}
