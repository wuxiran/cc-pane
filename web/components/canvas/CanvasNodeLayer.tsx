import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Grip, Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { canvasNodeMinimumSize } from "@/lib/canvasGeometry";
import { useCanvasDisplayStore, usePanesStore } from "@/stores";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import type { CanvasNodePosition, CanvasNodeProjection, NodeVisualState, PipeEvent } from "@/types/canvas";
import TerminalView, { type TerminalViewHandle } from "@/components/panes/TerminalView";
import {
  CANVAS_TERMINAL_INITIAL_FONT_SIZE,
  canvasTerminalZoomPersistenceKey,
} from "./canvasTerminalZoom";

interface CanvasNodeLayerProps {
  nodes: CanvasNodeProjection[];
  positions: Record<string, CanvasNodePosition>;
  events?: PipeEvent[];
  viewport?: { width: number; height: number };
  onPositionChange: (nodeId: string, position: CanvasNodePosition) => void;
}

const COMPLETED_FLASH_MS = 720;
const noop = () => {};

function colorForStatus(status: NodeVisualState): string {
  switch (status) {
    case "waiting": return "var(--app-status-warning)";
    case "completed": return "var(--app-status-success)";
    case "failed": return "var(--app-status-danger)";
    case "running": return "var(--app-accent)";
    case "offline": return "var(--app-text-tertiary)";
    default: return "var(--app-border)";
  }
}

function eventTouchesNode(event: PipeEvent, node: CanvasNodeProjection): boolean {
  return event.sourceId === node.id
    || event.targetId === node.id
    || Boolean(node.bindingId && (event.fromBinding === node.bindingId || event.toBinding === node.bindingId))
    || Boolean(node.sessionId && (event.fromSession === node.sessionId || event.toSession === node.sessionId));
}

function latestEvent(node: CanvasNodeProjection, events: PipeEvent[]): PipeEvent | undefined {
  return events
    .filter((event) => eventTouchesNode(event, node))
    .sort((left, right) => right.sequence - left.sequence)[0];
}

function useCompletedFlashKeys(nodes: CanvasNodeProjection[], enabled: boolean): Record<string, number> {
  const previous = useRef(new Map<string, NodeVisualState>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [keys, setKeys] = useState<Record<string, number>>({});

  useEffect(() => {
    const completed = nodes
      .filter((node) => node.status === "completed" && previous.current.get(node.id) !== "completed")
      .map((node) => node.id);
    previous.current = new Map(nodes.map((node) => [node.id, node.status]));
    if (!enabled || completed.length === 0) return;
    setKeys((current) => {
      const next = { ...current };
      completed.forEach((nodeId) => {
        next[nodeId] = (next[nodeId] ?? 0) + 1;
        const oldTimer = timers.current.get(nodeId);
        if (oldTimer) clearTimeout(oldTimer);
        timers.current.set(nodeId, setTimeout(() => {
          setKeys((active) => {
            const remaining = { ...active };
            delete remaining[nodeId];
            return remaining;
          });
          timers.current.delete(nodeId);
        }, COMPLETED_FLASH_MS));
      });
      return next;
    });
  }, [enabled, nodes]);

  useEffect(() => () => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
  }, []);

  return keys;
}

function openNode(node: CanvasNodeProjection): void {
  const panes = usePanesStore.getState();
  useCanvasDisplayStore.getState().setMode("panel");
  if (node.layoutId && node.layoutId !== panes.currentLayoutId) panes.switchLayout(node.layoutId);
  if (node.paneId) panes.setActivePane(node.paneId);
  if (node.paneId && node.tabId) panes.selectTab(node.paneId, node.tabId);
  if (node.tabId && node.leafId) panes.setActiveTerminalPane(node.tabId, node.leafId);
}

function CanvasTerminalMirror({ node }: { node: CanvasNodeProjection }) {
  const ownerId = node.tabId ?? `canvas:${node.id}`;
  const displayMode = useCanvasDisplayStore((state) => state.mode);
  const visible = displayMode === "canvas";
  const terminalRef = useRef<TerminalViewHandle | null>(null);

  useEffect(() => {
    useTabViewStateStore.getState().reportView(ownerId, "mirror", visible ? "visible" : "hidden");
    return () => useTabViewStateStore.getState().removeView(ownerId, "mirror");
  }, [ownerId, visible]);

  if (!node.sessionId) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
        {node.status === "offline" ? "Session unavailable" : "No active session"}
      </div>
    );
  }

  return (
    <div
      className="h-full"
      onPointerDownCapture={() => terminalRef.current?.focus()}
    >
      <TerminalView
        ref={terminalRef}
        sessionId={node.sessionId}
        projectPath={node.projectPath ?? ""}
        // Mirrors receive the original CLI identity as well as the session.
        // Managed CLI output then follows the same background sanitization
        // path as the primary terminal instead of falling back to plain shell.
        cliTool={node.cliTool}
        layoutActive={visible}
        layoutFitKey={`${node.id}:${displayMode}:${Math.round(node.position?.width ?? 0)}:${Math.round(node.position?.height ?? 0)}`}
        initialTerminalFontSize={CANVAS_TERMINAL_INITIAL_FONT_SIZE}
        terminalZoomPersistenceKey={canvasTerminalZoomPersistenceKey(node)}
        drivesBackendPty={false}
        resizeBackendPty
        // Canvas is an alternate terminal layout, not a passive preview. The
        // visible xterm must accept keyboard input and forward it to this PTY.
        readOnly={false}
        visibilityOwnerId={ownerId}
        viewRole="mirror"
        onSessionCreated={noop}
      />
    </div>
  );
}

function CanvasNodeCard({
  node,
  position,
  event,
  flashKey,
  viewport,
  onPositionChange,
}: {
  node: CanvasNodeProjection;
  position: CanvasNodePosition;
  event?: PipeEvent;
  flashKey?: number;
  viewport: { width: number; height: number };
  onPositionChange: CanvasNodeLayerProps["onPositionChange"];
}) {
  const { t } = useTranslation("orchestration");
  const drag = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resize = useRef<{ pointerId: number; startX: number; startY: number; originWidth: number; originHeight: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const color = colorForStatus(node.status);
  const animationIntensity = useCanvasDisplayStore((state) => state.animationIntensity);
  const minimumSize = canvasNodeMinimumSize(
    node,
    viewport.width,
    viewport.height,
    new Set(node.role === "leader" || (node.role !== "worker" && !node.parentId && !node.parentTabId && !node.parentSessionId) ? [node.id] : []),
  );
  const summary = event?.summary?.trim();
  const animation = animationIntensity === "off"
    ? undefined
    : node.status === "waiting"
      ? `canvas-node-waiting-breathe ${animationIntensity === "reduced" ? "3.6s" : "1.8s"} ease-in-out infinite`
      : flashKey
        ? `canvas-node-completed-flash ${animationIntensity === "reduced" ? "1.1s" : "720ms"} ease-out`
        : undefined;

  const statusLabel = t(`canvasStatus.${node.status}`, { defaultValue: node.status });
  const nodeTypeLabel = node.role === "leader"
    ? t("canvasNodeLeader")
    : node.role === "worker"
      ? t("canvasNodeWorker")
      : node.kind === "terminal"
        ? t("canvasNodeTerminal")
        : t("canvasNodeTask");

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) {
      drag.current = null;
      setDragging(false);
    }
  };

  return (
    <article
      data-flow-node-id={node.id}
      data-flow-status={node.status}
      data-flow-binding-id={node.bindingId}
      className={`absolute flex flex-col overflow-hidden border shadow-lg ${dragging ? "cursor-grabbing" : resizing ? "cursor-se-resize" : ""}`}
      style={{
        left: position.x,
        top: position.y,
        width: position.width,
        height: position.height,
        zIndex: dragging || resizing ? 30 : 10,
        borderColor: color,
        borderRadius: 6,
        // Let TerminalView own the terminal background/opacity, just like the
        // normal pane path. An app-content fill here would hide the wallpaper
        // before xterm's configured terminal opacity can be composited.
        background: "var(--app-panel-bg-effective)",
        boxShadow: `0 0 0 1px color-mix(in srgb, ${color} 18%, transparent), var(--sh-md)`,
        animation,
      }}
    >
      <div
        data-canvas-node-handle={node.id}
        data-testid={`canvas-node-handle-${node.id}`}
        className="flex h-9 shrink-0 select-none items-center gap-2 border-b px-2"
        style={{ borderColor: "color-mix(in srgb, var(--app-border) 80%, transparent)", background: "color-mix(in srgb, var(--app-panel-bg) 78%, transparent)" }}
        title={t("canvasMoveNode", { defaultValue: "Drag to move node" })}
        onPointerDown={(pointerEvent) => {
          if (pointerEvent.button !== 0) return;
          if (typeof pointerEvent.currentTarget.setPointerCapture === "function") {
            pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
          }
          drag.current = {
            pointerId: pointerEvent.pointerId,
            startX: pointerEvent.clientX,
            startY: pointerEvent.clientY,
            originX: position.x,
            originY: position.y,
          };
          setDragging(true);
        }}
        onPointerMove={(pointerEvent) => {
          const active = drag.current;
          if (!active || active.pointerId !== pointerEvent.pointerId) return;
          onPositionChange(node.id, {
            ...position,
            x: Math.max(8, Math.round(active.originX + pointerEvent.clientX - active.startX)),
            y: Math.max(8, Math.round(active.originY + pointerEvent.clientY - active.startY)),
          });
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <Grip className="h-3.5 w-3.5 shrink-0" style={{ color }} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
          {node.label}
        </span>
        <span className="shrink-0 text-[9px] uppercase tracking-[0.08em]" style={{ color }}>
          {nodeTypeLabel}
        </span>
        <button
          type="button"
          aria-label={t("canvasOpenTerminal", { name: node.label, defaultValue: `Open ${node.label}` })}
          title={t("canvasOpenTerminal", { name: node.label, defaultValue: `Open ${node.label}` })}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)]"
          style={{ color: "var(--app-text-secondary)" }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => openNode(node)}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <CanvasTerminalMirror node={{ ...node, position }} />
      </div>
      <div
        className="flex h-6 shrink-0 items-center gap-2 border-t px-2 text-[9px]"
        style={{
          color: "var(--app-text-tertiary)",
          background: "var(--app-menubar)",
          borderColor: "color-mix(in srgb, var(--app-border) 80%, transparent)",
        }}
        title={summary || statusLabel}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
        <span className="min-w-0 shrink-0 truncate">{statusLabel}</span>
        {summary ? <span className="min-w-0 flex-1 truncate">{summary}</span> : null}
        {node.cliTool ? <span className="ml-auto shrink-0 uppercase">{node.cliTool}</span> : null}
      </div>
      <button
        type="button"
        data-testid={`canvas-node-resize-${node.id}`}
        aria-label={t("canvasResizeNode", { name: node.label, defaultValue: `Resize ${node.label}` })}
        title={t("canvasResizeNode", { name: node.label, defaultValue: `Resize ${node.label}` })}
        className="absolute bottom-0 right-0 z-20 flex h-5 w-5 cursor-se-resize items-center justify-center border-l border-t opacity-70 transition-opacity hover:opacity-100"
        style={{ color, background: "color-mix(in srgb, var(--app-menubar) 88%, transparent)", borderColor: "color-mix(in srgb, var(--app-border) 80%, transparent)" }}
        onPointerDown={(pointerEvent) => {
          if (pointerEvent.button !== 0) return;
          pointerEvent.stopPropagation();
          if (typeof pointerEvent.currentTarget.setPointerCapture === "function") {
            pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
          }
          resize.current = {
            pointerId: pointerEvent.pointerId,
            startX: pointerEvent.clientX,
            startY: pointerEvent.clientY,
            originWidth: position.width,
            originHeight: position.height,
          };
          setResizing(true);
        }}
        onPointerMove={(pointerEvent) => {
          const active = resize.current;
          if (!active || active.pointerId !== pointerEvent.pointerId) return;
          onPositionChange(node.id, {
            ...position,
            width: Math.max(minimumSize.width, Math.round(active.originWidth + pointerEvent.clientX - active.startX)),
            height: Math.max(minimumSize.height, Math.round(active.originHeight + pointerEvent.clientY - active.startY)),
          });
        }}
        onPointerUp={(pointerEvent) => {
          if (resize.current?.pointerId === pointerEvent.pointerId) {
            resize.current = null;
            setResizing(false);
          }
        }}
        onPointerCancel={(pointerEvent) => {
          if (resize.current?.pointerId === pointerEvent.pointerId) {
            resize.current = null;
            setResizing(false);
          }
        }}
        onKeyDown={(keyboardEvent) => {
          const step = keyboardEvent.shiftKey ? 40 : 10;
          let deltaX = 0;
          let deltaY = 0;
          if (keyboardEvent.key === "ArrowRight") deltaX = step;
          if (keyboardEvent.key === "ArrowLeft") deltaX = -step;
          if (keyboardEvent.key === "ArrowDown") deltaY = step;
          if (keyboardEvent.key === "ArrowUp") deltaY = -step;
          if (deltaX === 0 && deltaY === 0) return;
          keyboardEvent.preventDefault();
          onPositionChange(node.id, {
            ...position,
            width: Math.max(minimumSize.width, position.width + deltaX),
            height: Math.max(minimumSize.height, position.height + deltaY),
          });
        }}
      >
        <Maximize2 className="h-3 w-3" aria-hidden="true" />
      </button>
    </article>
  );
}

export default function CanvasNodeLayer({
  nodes,
  positions,
  events = [],
  viewport = { width: 1200, height: 760 },
  onPositionChange,
}: CanvasNodeLayerProps) {
  const animationIntensity = useCanvasDisplayStore((state) => state.animationIntensity);
  const flashKeys = useCompletedFlashKeys(nodes, animationIntensity !== "off");
  const latestEvents = useMemo(
    () => new Map(nodes.map((node) => [node.id, latestEvent(node, events)])),
    [events, nodes],
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-[3]" aria-label="Canvas terminal nodes">
      {nodes.map((node) => {
        const position = positions[node.id];
        if (!position) return null;
        return (
          <div key={node.id} className="pointer-events-auto">
            <CanvasNodeCard
              node={node}
              position={position}
              event={latestEvents.get(node.id)}
              flashKey={flashKeys[node.id]}
              viewport={viewport}
              onPositionChange={onPositionChange}
            />
          </div>
        );
      })}
    </div>
  );
}
