import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, FileText, Grid2X2, LayoutPanelTop, Music, Pencil, Plus, RefreshCw, Scan, ScrollText, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import CanvasNodeLayer from "@/components/canvas/CanvasNodeLayer";
import PipeSvgLayer from "@/components/canvas/PipeSvgLayer";
import MediaCanvasTemplates from "./MediaCanvasTemplates";
import { defaultCanvasPositions } from "@/lib/canvasGeometry";
import { derivePipeEdges } from "@/lib/canvasProjection";
import { canvasSnapshotService } from "@/services/canvasSnapshotService";
import { mediaService } from "@/services/mediaService";
import { useMediaStore } from "@/stores";
import { useMediaCanvasStore } from "@/stores/useMediaCanvasStore";
import { getErrorMessage } from "@/utils";
import type { CanvasNodePosition } from "@/types/canvas";
import { MEDIA_NODE_SUBTYPE_PARAMETER, type MediaCanvasSpace, type MediaNodeSubtype } from "@/types/media";

interface MediaCanvasViewProps {
  workspaceId: string | null;
  layoutId: string | null;
  activeSpace?: MediaCanvasSpace | null;
  spaces?: MediaCanvasSpace[];
  onSpaceChange?: (space: MediaCanvasSpace) => void;
  refreshToken?: number;
}

interface CanvasViewTransform {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 3;
const IDENTITY_VIEW: CanvasViewTransform = { x: 0, y: 0, scale: 1 };
const VIEW_STORAGE_PREFIX = "cc-panes-media-canvas-view-v1";

function viewStorageKey(workspaceId: string, layoutId: string): string {
  return `${VIEW_STORAGE_PREFIX}:${encodeURIComponent(JSON.stringify([workspaceId, layoutId]))}`;
}

function loadViewTransform(workspaceId: string, layoutId: string): CanvasViewTransform | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(viewStorageKey(workspaceId, layoutId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CanvasViewTransform>;
    if (typeof value.x !== "number" || typeof value.y !== "number" || typeof value.scale !== "number") return null;
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.scale)) return null;
    return { x: value.x, y: value.y, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, value.scale)) };
  } catch {
    return null;
  }
}

export default function MediaCanvasView({ workspaceId, layoutId, activeSpace = null, spaces = [], onSpaceChange, refreshToken = 0 }: MediaCanvasViewProps) {
  const { t } = useTranslation("media");
  const nodes = useMediaStore((state) => state.nodes);
  const storeScopeKey = useMediaStore((state) => state.scopeKey);
  const edges = useMediaStore((state) => state.edges);
  const loading = useMediaStore((state) => state.loading);
  const error = useMediaStore((state) => state.error);
  const refresh = useMediaStore((state) => state.refresh);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [positions, setPositions] = useState<Record<string, CanvasNodePosition>>({});
  const [manualIds, setManualIds] = useState<Record<string, true>>({});
  // The infinite-canvas view transform: world = screen * scale + (x, y).
  const [view, setView] = useState<CanvasViewTransform>(IDENTITY_VIEW);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pan = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [panning, setPanning] = useState(false);

  // The named space owns the local geometry key. Its backend layoutId remains
  // the project graph key, while a workspace space queries the whole workspace.
  const logicalLayoutId = activeSpace?.id ?? layoutId;
  const queryLayoutId = activeSpace?.scope === "workspace" ? null : layoutId;
  const scopeKey = `${workspaceId ?? ""}:${logicalLayoutId ?? ""}`;
  const scopedNodes = useMemo(
    () => storeScopeKey === JSON.stringify([workspaceId, logicalLayoutId]) ? nodes : [],
    [logicalLayoutId, nodes, storeScopeKey, workspaceId],
  );
  const scopedEdges = useMemo(
    () => storeScopeKey === JSON.stringify([workspaceId, logicalLayoutId]) ? edges : [],
    [edges, logicalLayoutId, storeScopeKey, workspaceId],
  );
  const pipeEdges = useMemo(
    () => derivePipeEdges(scopedNodes, [], scopedEdges),
    [scopedEdges, scopedNodes],
  );
  const refreshScope = async () => { await refresh(workspaceId, logicalLayoutId, queryLayoutId); };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setViewport({ width: root.clientWidth, height: root.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [scopeKey]);

  useEffect(() => {
    void refreshScope();
    const timer = window.setInterval(() => void refreshScope(), 5000);
    let unlisten: (() => void) | undefined;
    void mediaService.listen(() => void refreshScope(), workspaceId).then((cleanup) => { unlisten = cleanup; });
    return () => {
      window.clearInterval(timer);
      unlisten?.();
    };
  // refreshScope intentionally changes with the selected scope, not with the
  // store function identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, scopeKey]);

  useEffect(() => {
    if (!workspaceId || !logicalLayoutId) {
      setPositions({});
      setManualIds({});
      setView(IDENTITY_VIEW);
      return;
    }
    const snapshot = canvasSnapshotService.load({ workspaceId, layoutId: logicalLayoutId });
    const saved = Object.fromEntries(snapshot?.nodes.flatMap((node) => node.position ? [[node.id, node.position] as const] : []) ?? []);
    setPositions(saved);
    setManualIds(Object.fromEntries(Object.keys(saved).map((id) => [id, true as const])));
    setView(loadViewTransform(workspaceId, logicalLayoutId) ?? IDENTITY_VIEW);
  }, [scopeKey, logicalLayoutId, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !logicalLayoutId || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(viewStorageKey(workspaceId, logicalLayoutId), JSON.stringify(view));
    } catch {
      // Restricted webviews may deny storage; the in-memory view still works.
    }
  }, [logicalLayoutId, view, workspaceId]);

  useEffect(() => {
    const automatic = defaultCanvasPositions(scopedNodes, viewport.width || 960, viewport.height || 620);
    setPositions((current) => {
      const next: Record<string, CanvasNodePosition> = {};
      for (const node of scopedNodes) next[node.id] = current[node.id] ?? automatic[node.id];
      return next;
    });
  }, [scopedNodes, viewport.height, viewport.width]);

  useEffect(() => {
    if (!workspaceId || !logicalLayoutId || Object.keys(manualIds).length === 0) return;
    const persisted = Object.keys(manualIds).flatMap((id) => positions[id] ? [{ id, position: positions[id] }] : []);
    canvasSnapshotService.save(
      { workspaceId, layoutId: logicalLayoutId },
      {
        version: 2,
        workspaceId,
        layoutId: logicalLayoutId,
        savedAt: new Date().toISOString(),
        displayMode: "canvas",
        animationIntensity: "full",
        nodes: persisted,
        customizedNodeIds: persisted.map((node) => node.id),
      },
    );
  }, [logicalLayoutId, manualIds, positions, workspaceId]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const pointX = clientX - rect.left;
    const pointY = clientY - rect.top;
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      if (scale === current.scale) return current;
      // Keep the world point under the cursor stationary while zooming.
      const worldX = (pointX - current.x) / current.scale;
      const worldY = (pointY - current.y) / current.scale;
      return { scale, x: pointX - worldX * scale, y: pointY - worldY * scale };
    });
  }, []);

  const zoomAtCenter = useCallback((factor: number) => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }, [zoomAt]);

  // React registers wheel listeners as passive; zooming must call
  // preventDefault so the surrounding layout never scrolls. Attach natively.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [scopeKey, zoomAt]);

  const fitView = useCallback(() => {
    const rects = scopedNodes.map((node) => positions[node.id]).filter(Boolean);
    const width = viewport.width || 960;
    const height = viewport.height || 620;
    if (rects.length === 0) {
      setView(IDENTITY_VIEW);
      return;
    }
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
    const padding = 48;
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min((width - padding * 2) / contentWidth, (height - padding * 2) / contentHeight, 1)),
    );
    setView({
      scale,
      x: (width - contentWidth * scale) / 2 - minX * scale,
      y: (height - contentHeight * scale) / 2 - minY * scale,
    });
  }, [positions, scopedNodes, viewport.height, viewport.width]);

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    // Left-drag pans only from empty canvas; node cards own their pointer
    // interactions. Middle-drag pans from anywhere.
    if (event.button === 0 && (event.target as HTMLElement).closest("[data-flow-node-id]")) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
    };
    setPanning(true);
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = pan.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setView((current) => ({
      ...current,
      x: active.originX + event.clientX - active.startX,
      y: active.originY + event.clientY - active.startY,
    }));
  };
  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pan.current?.pointerId === event.pointerId) {
      pan.current = null;
      setPanning(false);
    }
  };

  const visibleEdges = scopedEdges.length;
  const canvasConnections = visibleEdges ? t("canvasConnections", { count: visibleEdges }) : "";
  const gridSize = 24 * view.scale;

  const subtypeMenu: Array<{
    subtype: MediaNodeSubtype;
    labelKey: "nodeTypeText" | "nodeTypeScript" | "nodeTypeAudio" | "nodeTypeBoard" | "nodeTypeStoryboard";
    icon: typeof FileText;
  }> = [
    { subtype: "text", labelKey: "nodeTypeText", icon: FileText },
    { subtype: "script", labelKey: "nodeTypeScript", icon: ScrollText },
    { subtype: "audio", labelKey: "nodeTypeAudio", icon: Music },
    { subtype: "board", labelKey: "nodeTypeBoard", icon: LayoutPanelTop },
    { subtype: "storyboard", labelKey: "nodeTypeStoryboard", icon: Clapperboard },
  ];

  const handleAddNode = async (subtype: MediaNodeSubtype, title: string) => {
    if (!workspaceId || !layoutId) return;
    try {
      await mediaService.createNode({
        workspaceId,
        layoutId,
        kind: "image",
        title,
        defaultOperation: "textToImage",
        parameters: {
          [MEDIA_NODE_SUBTYPE_PARAMETER]: subtype,
          ...(subtype === "storyboard" ? { shots: [] } : {}),
        },
      });
      await refreshScope();
    } catch (error) {
      toast.error(t("nodeCreateFailed", { message: getErrorMessage(error) }));
    }
  };

  return (
    <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden" style={{ background: "var(--app-panel-bg)" }} data-testid="media-canvas-view">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-4" style={{ background: "var(--app-menubar)" }}>
        <Grid2X2 className="size-4" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
        {spaces.length > 0 ? (
          <>
            <Select
              value={activeSpace?.id ?? spaces[0]?.id}
              onValueChange={(value) => {
                const next = spaces.find((space) => space.id === value);
                if (next) onSpaceChange?.(next);
              }}
            >
              <SelectTrigger size="sm" className="h-7 max-w-52 border-transparent bg-transparent px-1.5 text-xs font-semibold shadow-none">
                <SelectValue placeholder={t("selectCanvasSpace")} />
              </SelectTrigger>
              <SelectContent>
                {spaces.map((space) => <SelectItem key={space.id} value={space.id}>{space.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {activeSpace ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("renameCanvasSpace")}
                  title={t("renameCanvasSpace")}
                  onClick={() => {
                    const next = window.prompt(t("renameCanvasSpacePrompt"), activeSpace.name)?.trim();
                    if (next && next !== activeSpace.name) {
                      useMediaCanvasStore.getState().renameSpace(activeSpace.id, next);
                    }
                  }}
                  data-testid="media-canvas-rename-space"
                >
                  <Pencil aria-hidden="true" />
                </Button>
                {spaces.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("removeCanvasSpace")}
                    title={t("removeCanvasSpace")}
                    onClick={() => {
                      // Removing a space drops only the local view metadata;
                      // durable nodes stay in the media graph.
                      if (!window.confirm(t("removeCanvasSpaceConfirm", { name: activeSpace.name }))) return;
                      const store = useMediaCanvasStore.getState();
                      store.removeSpace(activeSpace.id);
                      const fallback = spaces.find((space) => space.id !== activeSpace.id);
                      if (fallback) onSpaceChange?.(fallback);
                    }}
                    data-testid="media-canvas-remove-space"
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <span className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("projectCanvas")}</span>
        )}
        <span className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("canvasSummary", { nodes: scopedNodes.length, connections: canvasConnections })}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <MediaCanvasTemplates
            workspaceId={workspaceId}
            layoutId={layoutId}
            queryLayoutId={queryLayoutId}
            onApplied={() => void refreshScope()}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[11px]"
                disabled={!workspaceId || !layoutId}
                data-testid="media-canvas-add-node"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                {t("addNode")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {subtypeMenu.map(({ subtype, labelKey, icon: Icon }) => (
                <DropdownMenuItem key={subtype} onSelect={() => void handleAddNode(subtype, t(labelKey))}>
                  <Icon className="size-3.5" aria-hidden="true" />
                  {t(labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("zoomOut")} title={t("zoomOut")} onClick={() => zoomAtCenter(1 / 1.2)}><ZoomOut aria-hidden="true" /></Button>
          <button
            type="button"
            className="min-w-11 rounded px-1 text-center text-[10px] tabular-nums transition-colors hover:bg-[var(--app-hover)]"
            style={{ color: "var(--app-text-secondary)" }}
            aria-label={t("resetZoom")}
            title={t("resetZoom")}
            onClick={() => setView(IDENTITY_VIEW)}
            data-testid="media-canvas-zoom-level"
          >
            {Math.round(view.scale * 100)}%
          </button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("zoomIn")} title={t("zoomIn")} onClick={() => zoomAtCenter(1.2)}><ZoomIn aria-hidden="true" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("fitView")} title={t("fitView")} onClick={fitView}><Scan aria-hidden="true" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("refreshCanvas")} title={t("refreshCanvas")} disabled={loading} onClick={() => void refreshScope()}><RefreshCw className={loading ? "animate-spin" : ""} aria-hidden="true" /></Button>
        </div>
      </header>
      {/* Infinite canvas viewport: overflow-hidden with a pan/zoom transform,
          so the upstream scrollbar styling no longer applies here. */}
      <div
        ref={rootRef}
        className={`relative min-h-0 flex-1 overflow-hidden ${panning ? "cursor-grabbing" : "cursor-grab"}`}
        data-canvas-scroll-root
        style={{
          touchAction: "none",
          backgroundImage: "linear-gradient(color-mix(in srgb, var(--app-border) 22%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--app-border) 22%, transparent) 1px, transparent 1px)",
          backgroundSize: `${gridSize}px ${gridSize}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {error ? <div className="absolute left-4 top-4 z-10 max-w-[min(420px,calc(100%-2rem))] rounded-md border border-[var(--app-status-danger)] bg-[var(--app-panel-bg)] px-3 py-2 text-xs" style={{ color: "var(--app-status-danger)" }}>{error}</div> : null}
        {!workspaceId || !logicalLayoutId ? <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm" style={{ color: "var(--app-text-tertiary)" }}>{t("selectWorkspaceProjectHint")}</div> : scopedNodes.length === 0 && !loading ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center" style={{ color: "var(--app-text-tertiary)" }}><Grid2X2 className="size-8 opacity-40" aria-hidden="true" /><span>{t("emptyCanvasTitle")}</span><span className="text-xs">{t("emptyCanvasDescription")}</span></div> : null}
        <div
          className="absolute inset-0"
          data-testid="media-canvas-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "0 0" }}
        >
          <PipeSvgLayer edges={pipeEdges} positions={positions} />
          <CanvasNodeLayer
            nodes={scopedNodes}
            positions={positions}
            viewport={{ width: viewport.width || 960, height: viewport.height || 620 }}
            scale={view.scale}
            unbounded
            onPositionChange={(nodeId, position) => { setPositions((current) => ({ ...current, [nodeId]: position })); setManualIds((current) => ({ ...current, [nodeId]: true })); }}
          />
        </div>
      </div>
    </section>
  );
}
