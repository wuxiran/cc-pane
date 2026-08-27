import { useEffect, useMemo, useRef, useState } from "react";
import { Network } from "lucide-react";
import { useTranslation } from "react-i18next";
import { canvasNodeMinimumSize, defaultCanvasPositions } from "@/lib/canvasGeometry";
import { derivePipeEdges, projectCanvasNodes, resolveCanvasEventNodes } from "@/lib/canvasProjection";
import { activeLayout } from "@/stores/paneLayoutHelpers";
import { useCanvasDisplayStore, useCanvasStore, useMediaStore, useOrchestratorStore, usePanesStore, useWorkspacesStore } from "@/stores";
import { mediaService } from "@/services/mediaService";
import type { CanvasNodePosition, CanvasNodeProjection } from "@/types/canvas";
import CanvasNodeLayer from "./CanvasNodeLayer";
import CanvasDisplayToggle from "./CanvasDisplayToggle";
import ParticleCanvasLayer from "./ParticleCanvasLayer";
import PipeSvgLayer from "./PipeSvgLayer";
import { usePipePreviewEvents } from "./usePipePreviewEvents";

function positionsChanged(
  previous: Record<string, CanvasNodePosition>,
  next: Record<string, CanvasNodePosition>,
): boolean {
  const previousIds = Object.keys(previous);
  const nextIds = Object.keys(next);
  if (previousIds.length !== nextIds.length) return true;
  return nextIds.some((id) => {
    const before = previous[id];
    const after = next[id];
    return !before || before.x !== after.x || before.y !== after.y
      || before.width !== after.width || before.height !== after.height;
  });
}

function useCanvasViewport(rootRef: React.RefObject<HTMLDivElement | null>, displayMode: string) {
  // Do not invent a first viewport. A guessed 1200x760 viewport can create a
  // single-column layout before the real WebView size is known and that
  // transient geometry may then be mistaken for a user position.
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setViewport({ width: root.clientWidth, height: root.clientHeight });
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(root);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [displayMode, rootRef]);

  return viewport;
}

interface PaneFlowOverlayProps {
  /** Media projection is supplied by the media runtime when available. */
  mediaNodes?: CanvasNodeProjection[];
}

const EMPTY_MEDIA_NODES: CanvasNodeProjection[] = [];

export default function PaneFlowOverlay({ mediaNodes = EMPTY_MEDIA_NODES }: PaneFlowOverlayProps) {
  const { t } = useTranslation("orchestration");
  const layouts = usePanesStore((state) => state.layouts);
  const rootPane = usePanesStore((state) => state.rootPane);
  const currentLayoutId = usePanesStore((state) => state.currentLayoutId);
  const currentLayoutName = usePanesStore((state) => activeLayout(state)?.name);
  const workspaceId = useWorkspacesStore((state) => state.expandedWorkspaceId);
  const persistedMediaNodes = useMediaStore((state) => state.nodes);
  const persistedMediaEdges = useMediaStore((state) => state.edges);
  const refreshMedia = useMediaStore((state) => state.refresh);
  const bindings = useOrchestratorStore((state) => state.bindings);
  const projectedNodes = useMemo(() => {
    const projectionLayouts = layouts
      .filter((layout) => layout.kind !== "starred")
      .map((layout) => layout.id === currentLayoutId ? { ...layout, rootPane } : layout);
    return projectCanvasNodes({ bindings, layouts: projectionLayouts, layoutId: currentLayoutId, mediaNodes: [...persistedMediaNodes, ...mediaNodes] });
  }, [bindings, currentLayoutId, layouts, mediaNodes, persistedMediaNodes, rootPane]);
  const manualNodePositions = useCanvasStore((state) => state.nodePositions);
  const pendingRestoreNodeIds = useCanvasStore((state) => state.pendingRestoreNodeIds);
  const events = useCanvasStore((state) => state.events);
  const setNodes = useCanvasStore((state) => state.setNodes);
  const setNodePosition = useCanvasStore((state) => state.setNodePosition);
  const loadSnapshot = useCanvasStore((state) => state.loadSnapshot);
  const saveSnapshot = useCanvasStore((state) => state.saveSnapshot);
  const mode = useCanvasDisplayStore((state) => state.mode);
  const intensity = useCanvasDisplayStore((state) => state.animationIntensity);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewport = useCanvasViewport(rootRef, mode);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const snapshotPositions = useRef<Record<string, CanvasNodePosition>>({});
  const snapshotScope = useMemo(
    () => ({ workspaceId, layoutId: currentLayoutId }),
    [currentLayoutId, workspaceId],
  );
  const snapshotScopeKey = JSON.stringify([snapshotScope.workspaceId, snapshotScope.layoutId]);

  useEffect(() => {
    let cancelled = false;
    void refreshMedia(workspaceId, currentLayoutId);
    let unlisten: (() => void) | undefined;
    void mediaService.listen(() => {
      if (!cancelled) void refreshMedia(workspaceId, currentLayoutId);
    }, workspaceId).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    const timer = window.setInterval(() => {
      void refreshMedia(workspaceId, currentLayoutId);
    }, 5000);
    return () => {
      cancelled = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [currentLayoutId, refreshMedia, workspaceId]);

  useEffect(() => {
    setLoadedScope(null);
    snapshotPositions.current = {};
    loadSnapshot(snapshotScope);
    setLoadedScope(snapshotScopeKey);
  }, [loadSnapshot, snapshotScope, snapshotScopeKey]);

  useEffect(() => {
    setNodes(projectedNodes);
  }, [projectedNodes, setNodes]);

  // Projection is the source of truth for live task/session status. The store
  // contributes only coordinates explicitly changed by drag/resize.
  const nodes = projectedNodes;
  const fallbackPositions = useMemo(
    () => defaultCanvasPositions(nodes, viewport.width, viewport.height),
    [nodes, viewport.height, viewport.width],
  );
  const rootIds = useMemo(() => {
    const ids = new Set(nodes.map((node) => node.id));
    const byTabId = new Set(nodes.map((node) => node.tabId).filter((tabId): tabId is string => Boolean(tabId)));
    return new Set(
      nodes
        .filter((node) => {
          const hasParentNode = node.parentId && ids.has(node.parentId);
          const hasParentTab = node.parentTabId && byTabId.has(node.parentTabId);
          const hasParentSession = node.parentSessionId && nodes.some((candidate) => candidate.sessionId === node.parentSessionId);
          return !hasParentNode && !hasParentTab && !hasParentSession;
        })
        .map((node) => node.id),
    );
  }, [nodes]);
  const positions = useMemo(() => Object.fromEntries(
    nodes.map((node) => {
      const position = manualNodePositions[node.id] ?? fallbackPositions[node.id];
      const minimum = canvasNodeMinimumSize(node, viewport.width, viewport.height, rootIds);
      return [node.id, position ? {
        ...position,
        width: Math.max(position.width, minimum.width),
        height: Math.max(position.height, minimum.height),
      } : position];
    }),
  ), [fallbackPositions, manualNodePositions, nodes, rootIds, viewport.height, viewport.width]);
  const normalizedEvents = useMemo(
    () => resolveCanvasEventNodes(events, nodes),
    [events, nodes],
  );
  const edges = useMemo(() => derivePipeEdges(nodes, normalizedEvents, persistedMediaEdges), [nodes, normalizedEvents, persistedMediaEdges]);
  const previewEvents = usePipePreviewEvents(
    edges,
    mode === "canvas",
  );
  const renderedEvents = useMemo(
    () => [...normalizedEvents, ...previewEvents],
    [normalizedEvents, previewEvents],
  );
  const canvasSize = useMemo(() => {
    const maxRight = Object.values(positions).reduce((max, position) => Math.max(max, position.x + position.width), 0);
    const maxBottom = Object.values(positions).reduce((max, position) => Math.max(max, position.y + position.height), 0);
    const padding = Math.max(24, Math.min(72, Math.min(viewport.width, viewport.height) * 0.05));
    return {
      width: Math.max(viewport.width, maxRight + padding),
      height: Math.max(viewport.height, maxBottom + padding),
    };
  }, [positions, viewport.height, viewport.width]);

  useEffect(() => {
    // The Canvas subtree stays mounted while the normal pane surface is shown.
    // Never persist a hidden/zero measurement or automatic coordinates derived
    // from the normal layout; only an active Canvas viewport may be snapshotted.
    if (mode !== "canvas" || viewport.width <= 1 || viewport.height <= 1) return;
    if (loadedScope !== snapshotScopeKey || Object.keys(positions).length === 0) return;
    // Do not overwrite a restored snapshot while bindings/session projection
    // is still hydrating. The missing nodes will clear this gate in setNodes().
    if (Object.keys(pendingRestoreNodeIds).length > 0) return;
    if (!positionsChanged(snapshotPositions.current, positions)) return;
    snapshotPositions.current = positions;
    const timeout = setTimeout(() => {
      saveSnapshot(snapshotScope, {
        displayMode: mode,
        animationIntensity: intensity,
        nodes: nodes.map((node) => ({ ...node, position: positions[node.id] ?? node.position })),
      });
    }, 250);
    return () => clearTimeout(timeout);
  }, [intensity, loadedScope, mode, nodes, pendingRestoreNodeIds, positions, saveSnapshot, snapshotScope, snapshotScopeKey, viewport.height, viewport.width]);

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-canvas-view
      data-canvas-layout-id={currentLayoutId}
      aria-label="Terminal canvas"
    >
      <header
        className="flex h-9 shrink-0 items-center justify-between border-b px-3"
        style={{ background: "var(--app-panel-bg-effective)", borderColor: "var(--app-border)" }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Network className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
          <span className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>Canvas</span>
          <span
            className="max-w-[16rem] truncate text-[10px]"
            style={{ color: "var(--app-text-secondary)" }}
            title={currentLayoutName ?? currentLayoutId}
          >
            {currentLayoutName ?? currentLayoutId}
          </span>
          <span className="text-[10px] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>{nodes.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <CanvasDisplayToggle />
        </div>
      </header>
      <div ref={rootRef} data-canvas-scroll-root className="relative min-h-0 flex-1 overflow-auto" style={{ background: "var(--app-panel-bg-effective)" }}>
        {nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            {t("canvasEmpty")}
          </div>
        ) : viewport.width <= 0 || viewport.height <= 0 ? null : (
          <div
            className={`canvas-animation-${intensity} relative shrink-0`}
            data-canvas-surface
            data-canvas-preview-count={previewEvents.length}
            style={{ width: canvasSize.width, height: canvasSize.height }}
          >
            <PipeSvgLayer edges={edges} positions={positions} events={renderedEvents} />
            <ParticleCanvasLayer edges={edges} events={renderedEvents} positions={positions} animationIntensity={intensity} />
            <CanvasNodeLayer
              nodes={nodes}
              positions={positions}
              events={renderedEvents}
              viewport={viewport}
              onPositionChange={setNodePosition}
            />
          </div>
        )}
      </div>
    </section>
  );
}
