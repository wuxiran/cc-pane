import { useEffect, useMemo, useRef, useState } from "react";
import { Grid2X2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import CanvasNodeLayer from "@/components/canvas/CanvasNodeLayer";
import PipeSvgLayer from "@/components/canvas/PipeSvgLayer";
import { defaultCanvasPositions } from "@/lib/canvasGeometry";
import { derivePipeEdges } from "@/lib/canvasProjection";
import { canvasSnapshotService } from "@/services/canvasSnapshotService";
import { mediaService } from "@/services/mediaService";
import { useMediaStore } from "@/stores";
import type { CanvasNodePosition } from "@/types/canvas";
import type { MediaCanvasSpace } from "@/types/media";

interface MediaCanvasViewProps {
  workspaceId: string | null;
  layoutId: string | null;
  activeSpace?: MediaCanvasSpace | null;
  spaces?: MediaCanvasSpace[];
  onSpaceChange?: (space: MediaCanvasSpace) => void;
  refreshToken?: number;
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
      return;
    }
    const snapshot = canvasSnapshotService.load({ workspaceId, layoutId: logicalLayoutId });
    const saved = Object.fromEntries(snapshot?.nodes.flatMap((node) => node.position ? [[node.id, node.position] as const] : []) ?? []);
    setPositions(saved);
    setManualIds(Object.fromEntries(Object.keys(saved).map((id) => [id, true as const])));
  }, [scopeKey, logicalLayoutId, workspaceId]);

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

  const visibleEdges = scopedEdges.length;
  const canvasConnections = visibleEdges ? t("canvasConnections", { count: visibleEdges }) : "";

  return (
    <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden" style={{ background: "var(--app-panel-bg)" }} data-testid="media-canvas-view">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-4" style={{ background: "var(--app-menubar)" }}>
        <Grid2X2 className="size-4" style={{ color: "var(--app-accent)" }} aria-hidden="true" />
        {spaces.length > 0 ? (
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
        ) : (
          <span className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("projectCanvas")}</span>
        )}
        <span className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("canvasSummary", { nodes: scopedNodes.length, connections: canvasConnections })}</span>
        <div className="ml-auto"><Button type="button" variant="ghost" size="icon-sm" aria-label={t("refreshCanvas")} title={t("refreshCanvas")} disabled={loading} onClick={() => void refreshScope()}><RefreshCw className={loading ? "animate-spin" : ""} aria-hidden="true" /></Button></div>
      </header>
      <div ref={rootRef} className="relative min-h-0 flex-1 overflow-auto" data-canvas-scroll-root>
        <div className="relative min-h-full" style={{ minWidth: Math.max(viewport.width, 720), minHeight: Math.max(viewport.height, 520), backgroundImage: "linear-gradient(color-mix(in srgb, var(--app-border) 22%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--app-border) 22%, transparent) 1px, transparent 1px)", backgroundSize: "24px 24px" }}>
          {error ? <div className="absolute left-4 top-4 z-10 max-w-[min(420px,calc(100%-2rem))] rounded-md border border-[var(--app-status-danger)] bg-[var(--app-panel-bg)] px-3 py-2 text-xs" style={{ color: "var(--app-status-danger)" }}>{error}</div> : null}
          {!workspaceId || !logicalLayoutId ? <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm" style={{ color: "var(--app-text-tertiary)" }}>{t("selectWorkspaceProjectHint")}</div> : scopedNodes.length === 0 && !loading ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center" style={{ color: "var(--app-text-tertiary)" }}><Grid2X2 className="size-8 opacity-40" aria-hidden="true" /><span>{t("emptyCanvasTitle")}</span><span className="text-xs">{t("emptyCanvasDescription")}</span></div> : null}
          <PipeSvgLayer edges={pipeEdges} positions={positions} />
          <CanvasNodeLayer nodes={scopedNodes} positions={positions} viewport={{ width: viewport.width || 960, height: viewport.height || 620 }} onPositionChange={(nodeId, position) => { setPositions((current) => ({ ...current, [nodeId]: position })); setManualIds((current) => ({ ...current, [nodeId]: true })); }} />
        </div>
      </div>
    </section>
  );
}
