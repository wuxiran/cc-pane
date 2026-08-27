import type { CanvasNodePosition, CanvasNodeProjection, PipeEdge } from "@/types/canvas";

export interface RectLike { left: number; top: number; width: number; height: number }

export interface CanvasNodeSize { width: number; height: number }

/**
 * These are layout constraints, not card dimensions. The actual card size is
 * derived from the current canvas viewport and the node's role.
 */
const MIN_READABLE_WIDTH = 300;
const MIN_READABLE_HEIGHT = 210;
const MIN_WORKER_WIDTH = 360;
const MIN_WORKER_HEIGHT = 250;
const MAX_WORKER_WIDTH = 660;
const MAX_WORKER_HEIGHT = 470;
const MIN_PRIMARY_WIDTH = 540;
const MIN_PRIMARY_HEIGHT = 370;
const MAX_PRIMARY_WIDTH = 900;
const MAX_PRIMARY_HEIGHT = 620;
const MIN_MEDIA_WIDTH = 240;
const MIN_MEDIA_HEIGHT = 180;
const MAX_MEDIA_WIDTH = 760;
const MAX_MEDIA_HEIGHT = 520;
const CARD_SIZE_SCALE = 1.08;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isPrimaryNode(node: CanvasNodeProjection, rootIds: Set<string>): boolean {
  return node.role === "leader" || (node.role !== "worker" && rootIds.has(node.id));
}

/** Responsive card dimensions for a Canvas node. */
export function canvasNodeSize(
  node: CanvasNodeProjection,
  viewportWidth: number,
  viewportHeight = 760,
  rootIds: Set<string> = new Set(),
): CanvasNodeSize {
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const shortEdge = Math.min(width, height);
  if (node.kind === "media") {
    // Media previews should remain usable on narrow mobile WebViews instead
    // of inheriting the terminal leader's 540px primary-card minimum.
    const availableWidth = Math.max(1, width - 32);
    const availableHeight = Math.max(1, height - 32);
    const minimumWidth = Math.min(MIN_MEDIA_WIDTH, availableWidth);
    const minimumHeight = Math.min(MIN_MEDIA_HEIGHT, availableHeight);
    return {
      width: Math.round(clamp(Math.max(width * 0.42, shortEdge * 0.72) * CARD_SIZE_SCALE, minimumWidth, Math.max(minimumWidth, Math.min(MAX_MEDIA_WIDTH, availableWidth)))),
      height: Math.round(clamp(Math.max(height * 0.42, shortEdge * 0.58) * CARD_SIZE_SCALE, minimumHeight, Math.max(minimumHeight, Math.min(MAX_MEDIA_HEIGHT, availableHeight)))),
    };
  }
  // Use both viewport axes so a wide desktop canvas does not collapse into
  // two small cards just because its height is the shorter edge. Bounds are
  // readability guardrails; the normal size remains viewport-derived.
  const workerWidth = clamp(
    Math.max(width * 0.28, shortEdge * 0.45) * CARD_SIZE_SCALE,
    MIN_WORKER_WIDTH,
    MAX_WORKER_WIDTH,
  );
  const workerHeight = clamp(
    Math.max(height * 0.32, shortEdge * 0.32) * CARD_SIZE_SCALE,
    MIN_WORKER_HEIGHT,
    MAX_WORKER_HEIGHT,
  );

  if (!isPrimaryNode(node, rootIds)) {
    return { width: Math.round(workerWidth), height: Math.round(workerHeight) };
  }

  return {
    width: Math.round(clamp(Math.max(workerWidth * 1.25, width * 0.36) * CARD_SIZE_SCALE, MIN_PRIMARY_WIDTH, MAX_PRIMARY_WIDTH)),
    height: Math.round(clamp(Math.max(workerHeight * 1.30, height * 0.50) * CARD_SIZE_SCALE, MIN_PRIMARY_HEIGHT, MAX_PRIMARY_HEIGHT)),
  };
}

/** Minimum size used by the interactive resize handle. */
export function canvasNodeMinimumSize(
  node: CanvasNodeProjection,
  viewportWidth: number,
  viewportHeight = 760,
  rootIds: Set<string> = new Set(),
): CanvasNodeSize {
  const preferred = canvasNodeSize(node, viewportWidth, viewportHeight, rootIds);
  if (node.kind === "media") {
    const availableWidth = Math.max(1, viewportWidth - 32);
    const availableHeight = Math.max(1, viewportHeight - 32);
    return {
      width: Math.round(Math.min(availableWidth, Math.max(Math.min(MIN_READABLE_WIDTH, availableWidth), preferred.width * 0.58))),
      height: Math.round(Math.min(availableHeight, Math.max(Math.min(MIN_READABLE_HEIGHT, availableHeight), preferred.height * 0.58))),
    };
  }
  return {
    width: Math.round(Math.max(MIN_READABLE_WIDTH, preferred.width * 0.58)),
    height: Math.round(Math.max(MIN_READABLE_HEIGHT, preferred.height * 0.58)),
  };
}

export interface CubicCurve {
  startX: number;
  startY: number;
  control1X: number;
  control1Y: number;
  control2X: number;
  control2Y: number;
  endX: number;
  endY: number;
}

export function rectToCanvasPosition(rect: RectLike, container: RectLike): CanvasNodePosition {
  return {
    x: rect.left - container.left,
    y: rect.top - container.top,
    width: rect.width,
    height: rect.height,
  };
}

function parentNodeId(
  node: CanvasNodeProjection,
  byId: Map<string, CanvasNodeProjection>,
  byTabId: Map<string, string>,
  bySessionId: Map<string, string>,
): string | undefined {
  if (node.parentId && byId.has(node.parentId)) return node.parentId;
  if (node.parentTabId) {
    const parentByTab = byTabId.get(node.parentTabId);
    if (parentByTab) return parentByTab;
  }
  if (node.parentSessionId) {
    const parentBySession = bySessionId.get(node.parentSessionId);
    if (parentBySession) return parentBySession;
  }

  // A few older bindings only persisted the role. When there is exactly one
  // visible leader, treating worker nodes as its children preserves the
  // intended topology without guessing across multiple independent leaders.
  if (node.role === "worker") {
    const leaders = [...byId.values()].filter((candidate) => candidate.role === "leader");
    if (leaders.length === 1 && leaders[0].id !== node.id) return leaders[0].id;
  }
  return undefined;
}

function nodeDepth(
  node: CanvasNodeProjection,
  byId: Map<string, CanvasNodeProjection>,
  byTabId: Map<string, string>,
  bySessionId: Map<string, string>,
  visiting: Set<string>,
): number {
  const parentId = parentNodeId(node, byId, byTabId, bySessionId);
  if (!parentId) return 0;
  if (visiting.has(node.id)) return 0;
  const parent = byId.get(parentId);
  if (!parent) return 0;
  visiting.add(node.id);
  const depth = nodeDepth(parent, byId, byTabId, bySessionId, visiting) + 1;
  visiting.delete(node.id);
  return depth;
}

/**
 * Responsive tree projection used until a user supplies a saved Canvas
 * position. Leaders occupy the primary column; workers are packed into a
 * readable grid instead of being stacked into one narrow strip.
 */
export function defaultCanvasPositions(
  nodes: CanvasNodeProjection[],
  viewportWidth = 1200,
  viewportHeight = 760,
): Record<string, CanvasNodePosition> {
  if (nodes.length === 0) return {};

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byTabId = new Map(nodes.flatMap((node) => node.tabId ? [[node.tabId, node.id] as const] : []));
  const bySessionId = new Map(nodes.flatMap((node) => node.sessionId ? [[node.sessionId, node.id] as const] : []));
  const rootIds = new Set(
    nodes
      .filter((node) => !parentNodeId(node, byId, byTabId, bySessionId))
      .map((node) => node.id),
  );
  const levels = new Map<number, CanvasNodeProjection[]>();
  nodes.forEach((node) => {
    const depth = nodeDepth(node, byId, byTabId, bySessionId, new Set());
    const level = levels.get(depth) ?? [];
    level.push(node);
    levels.set(depth, level);
  });

  const shortEdge = Math.min(Math.max(1, viewportWidth), Math.max(1, viewportHeight));
  const padding = clamp(shortEdge * 0.035, 24, 48);
  const gap = clamp(shortEdge * 0.035, 24, 48);
  const sizes = new Map(
    nodes.map((node) => [node.id, canvasNodeSize(node, viewportWidth, viewportHeight, rootIds)]),
  );
  const roots = levels.get(0) ?? nodes.filter((node) => rootIds.has(node.id));
  const layoutRoots = roots.length > 0 ? roots : nodes;
  const rootCellWidth = Math.max(...layoutRoots.map((node) => sizes.get(node.id)?.width ?? 1));
  const rootCellHeight = Math.max(...layoutRoots.map((node) => sizes.get(node.id)?.height ?? 1));
  const availableRootWidth = Math.max(1, viewportWidth - padding * 2);
  const rootColumns = Math.max(
    1,
    Math.min(
      layoutRoots.length,
      Math.floor((availableRootWidth + gap) / (rootCellWidth + gap)),
    ),
  );
  const rootRows = Math.ceil(layoutRoots.length / rootColumns);
  const rootAreaWidth = rootColumns * rootCellWidth + Math.max(0, rootColumns - 1) * gap;
  const rootAreaHeight = rootRows * rootCellHeight + Math.max(0, rootRows - 1) * gap;

  const positions: Record<string, CanvasNodePosition> = {};

  let contentHeight = rootAreaHeight;
  let cursorX = rootAreaWidth + gap;
  const levelLayouts: Array<{
    nodes: CanvasNodeProjection[];
    x: number;
    cellWidth: number;
    cellHeight: number;
    columns: number;
    height: number;
  }> = [];

  [...levels.entries()]
    .filter(([depth]) => depth > 0)
    .sort(([left], [right]) => left - right)
    .forEach(([, level]) => {
      const cellWidth = Math.max(...level.map((node) => sizes.get(node.id)?.width ?? 1));
      const cellHeight = Math.max(...level.map((node) => sizes.get(node.id)?.height ?? 1));
      // A balanced grid keeps two workers side by side and three workers in a
      // 2x2 shape. The canvas can scroll when cards do not fit vertically;
      // preserving readable cards is more useful than a single compressed row.
      const columns = Math.max(1, Math.min(level.length, Math.ceil(Math.sqrt(level.length))));
      const rows = Math.ceil(level.length / columns);
      const levelHeight = rows * cellHeight + Math.max(0, rows - 1) * gap;
      levelLayouts.push({ nodes: level, x: cursorX, cellWidth, cellHeight, columns, height: levelHeight });
      contentHeight = Math.max(contentHeight, levelHeight);
      cursorX += columns * cellWidth + Math.max(0, columns - 1) * gap + gap;
    });

  const contentWidth = Math.max(
    rootAreaWidth,
    ...levelLayouts.map(({ x, cellWidth, columns }) => x + columns * cellWidth + Math.max(0, columns - 1) * gap),
  );
  const originX = Math.max(padding, (viewportWidth - contentWidth) / 2);
  const originY = Math.max(padding, (viewportHeight - contentHeight) / 2);

  layoutRoots.forEach((node, index) => {
    const size = sizes.get(node.id) ?? { width: rootCellWidth, height: rootCellHeight };
    const column = index % rootColumns;
    const row = Math.floor(index / rootColumns);
    positions[node.id] = {
      x: originX + column * (rootCellWidth + gap) + (rootCellWidth - size.width) / 2,
      y: originY + (contentHeight - rootAreaHeight) / 2 + row * (rootCellHeight + gap) + (rootCellHeight - size.height) / 2,
      width: size.width,
      height: size.height,
    };
  });

  levelLayouts.forEach(({ nodes: level, x, cellWidth, cellHeight, columns, height }) => {
    level.forEach((node, index) => {
      const size = sizes.get(node.id) ?? { width: cellWidth, height: cellHeight };
      const column = index % columns;
      const row = Math.floor(index / columns);
      positions[node.id] = {
        x: originX + x + column * (cellWidth + gap) + (cellWidth - size.width) / 2,
        y: originY + (contentHeight - height) / 2 + row * (cellHeight + gap) + (cellHeight - size.height) / 2,
        width: size.width,
        height: size.height,
      };
    });
  });

  return positions;
}

export function edgeCurve(source: CanvasNodePosition, target: CanvasNodePosition): CubicCurve {
  const sourceCenterX = source.x + source.width / 2;
  const targetCenterX = target.x + target.width / 2;
  const direction = targetCenterX >= sourceCenterX ? 1 : -1;
  const startX = direction === 1 ? source.x + source.width : source.x;
  const startY = source.y + source.height / 2;
  const endX = direction === 1 ? target.x : target.x + target.width;
  const endY = target.y + target.height / 2;
  const bend = Math.max(32, Math.abs(endX - startX) * 0.45);
  return {
    startX,
    startY,
    control1X: startX + direction * bend,
    control1Y: startY,
    control2X: endX - direction * bend,
    control2Y: endY,
    endX,
    endY,
  };
}

export function edgePath(source: CanvasNodePosition, target: CanvasNodePosition): string {
  const curve = edgeCurve(source, target);
  return `M ${curve.startX} ${curve.startY} C ${curve.control1X} ${curve.control1Y}, ${curve.control2X} ${curve.control2Y}, ${curve.endX} ${curve.endY}`;
}

export function pointOnCubicCurve(curve: CubicCurve, progress: number): { x: number; y: number } {
  const t = Math.min(1, Math.max(0, progress));
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * curve.startX + 3 * inverse ** 2 * t * curve.control1X + 3 * inverse * t ** 2 * curve.control2X + t ** 3 * curve.endX,
    y: inverse ** 3 * curve.startY + 3 * inverse ** 2 * t * curve.control1Y + 3 * inverse * t ** 2 * curve.control2Y + t ** 3 * curve.endY,
  };
}

export function visibleEdges(edges: PipeEdge[], positions: Record<string, CanvasNodePosition>): PipeEdge[] {
  return edges.filter((edge) => positions[edge.sourceId] && positions[edge.targetId]);
}
