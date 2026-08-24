import type { PaneNode, TaskBinding } from "@/types";

export type CanvasDisplayMode = "panel" | "canvas";
export type NodeVisualState = "pending" | "running" | "waiting" | "completed" | "failed" | "idle" | "offline";
export type PipeEventKind = "dispatch" | "message" | "report";
export type PipeEventPhase = "queued" | "flowing" | "delivered" | "failed";

export interface CanvasNodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasNodeProjection {
  id: string;
  label: string;
  kind: "task" | "terminal";
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

export interface CanvasSnapshot {
  version: 1;
  workspaceId: string | null;
  layoutId: string;
  savedAt: string;
  displayMode: CanvasDisplayMode;
  animationIntensity: "off" | "reduced" | "full";
  nodes: CanvasNodeProjection[];
  /** Only nodes explicitly moved or resized by the user keep a position. */
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
}
