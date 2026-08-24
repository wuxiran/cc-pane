import { useCallback, useEffect, useRef, useState } from "react";
import { useCanvasDisplayStore, useOrchestratorStore, usePanesStore } from "@/stores";
import type { CanvasNodeProjection, CanvasNodePosition, NodeVisualState, PipeEvent } from "@/types/canvas";

interface PipeLabelLayerProps {
  nodes: CanvasNodeProjection[];
  positions: Record<string, CanvasNodePosition>;
  events?: PipeEvent[];
}

const COMPLETED_FLASH_MS = 720;

function navigate(node: CanvasNodeProjection): void {
  const panes = usePanesStore.getState();
  if (node.layoutId && node.layoutId !== panes.currentLayoutId) panes.switchLayout(node.layoutId);
  if (node.paneId) panes.setActivePane(node.paneId);
  if (node.paneId && node.tabId) panes.selectTab(node.paneId, node.tabId);
  if (node.tabId && node.leafId) panes.setActiveTerminalPane(node.tabId, node.leafId);
}

function eventTouchesNode(event: PipeEvent, node: CanvasNodeProjection): boolean {
  const sourceMatches = event.sourceId === node.id
    || (node.bindingId && event.fromBinding === node.bindingId)
    || (node.sessionId && event.fromSession === node.sessionId);
  const targetMatches = event.targetId === node.id
    || (node.bindingId && event.toBinding === node.bindingId)
    || (node.sessionId && event.toSession === node.sessionId);
  return Boolean(sourceMatches || targetMatches);
}

function latestNodeEvent(node: CanvasNodeProjection, events: PipeEvent[]): PipeEvent | undefined {
  return [...events]
    .filter((event) => eventTouchesNode(event, node))
    .sort((left, right) => right.sequence - left.sequence)[0];
}

function nodeColor(status: NodeVisualState): string {
  switch (status) {
    case "waiting": return "var(--app-status-warning)";
    case "completed": return "var(--app-status-success)";
    case "failed": return "var(--app-status-danger)";
    case "offline": return "var(--app-text-tertiary)";
    case "running": return "var(--app-accent)";
    default: return "var(--app-border)";
  }
}

function useCompletedFlashKeys(nodes: CanvasNodeProjection[], enabled: boolean): Record<string, number> {
  const previousStatuses = useRef(new Map<string, NodeVisualState>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [flashKeys, setFlashKeys] = useState<Record<string, number>>({});

  useEffect(() => {
    const newlyCompleted = nodes
      .filter((node) => node.status === "completed" && previousStatuses.current.get(node.id) !== "completed")
      .map((node) => node.id);
    previousStatuses.current = new Map(nodes.map((node) => [node.id, node.status]));
    if (!enabled || newlyCompleted.length === 0) return;

    setFlashKeys((current) => {
      const next = { ...current };
      newlyCompleted.forEach((nodeId) => {
        next[nodeId] = (next[nodeId] ?? 0) + 1;
        const previousTimer = timers.current.get(nodeId);
        if (previousTimer) clearTimeout(previousTimer);
        timers.current.set(nodeId, setTimeout(() => {
          setFlashKeys((active) => {
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

  return flashKeys;
}

export default function PipeLabelLayer({ nodes, positions, events = [] }: PipeLabelLayerProps) {
  const bindings = useOrchestratorStore((state) => state.bindings);
  const animationIntensity = useCanvasDisplayStore((state) => state.animationIntensity);
  const completedFlashKeys = useCompletedFlashKeys(nodes, animationIntensity !== "off");
  const resolveBindingId = useCallback((node: CanvasNodeProjection) => {
    if (node.bindingId) return node.bindingId;
    const match = bindings.find((binding) =>
      (node.sessionId && binding.sessionId === node.sessionId) ||
      (node.tabId && binding.tabId === node.tabId),
    );
    return match?.id;
  }, [bindings]);

  return (
    <div className="pointer-events-none absolute inset-0" aria-label="Canvas flow labels">
      {nodes.map((node) => {
        const position = positions[node.id];
        if (!position) return null;
        const bindingId = resolveBindingId(node);
        const event = latestNodeEvent(node, events);
        const summary = event?.summary?.trim();
        const color = nodeColor(node.status);
        const waitingAnimationDuration = animationIntensity === "reduced" ? "3.6s" : "1.8s";
        const completedAnimationDuration = animationIntensity === "reduced" ? "1.1s" : "720ms";
        const animation = animationIntensity === "off"
          ? undefined
          : node.status === "waiting"
            ? `canvas-node-waiting-breathe ${waitingAnimationDuration} ease-in-out infinite`
            : completedFlashKeys[node.id]
              ? `canvas-node-completed-flash ${completedAnimationDuration} ease-out`
              : undefined;
        const label = summary ? `${node.label}: ${summary}` : node.label;
        const maxLabelWidth = Math.max(24, Math.min(220, position.width - 8));
        return (
          <div key={node.id} data-flow-node-id={node.id} data-flow-status={node.status}>
            <div
              className="pointer-events-none absolute"
              aria-hidden="true"
              style={{
                left: position.x + 1,
                top: position.y + 1,
                width: Math.max(0, position.width - 2),
                height: Math.max(0, position.height - 2),
                border: `1px solid ${color}`,
                borderRadius: 3,
                opacity: node.status === "offline" ? 0.55 : 0.9,
                boxShadow: node.status === "waiting" ? `0 0 0 1px color-mix(in srgb, ${color} 24%, transparent)` : undefined,
                animation,
              }}
            />
            <button
              type="button"
              title={label}
              aria-label={`Open ${label}`}
              className="pointer-events-auto absolute min-w-0 max-w-[220px] truncate border px-1.5 py-1 text-left text-[10px] leading-3 shadow-sm transition-colors hover:bg-[var(--app-active-bg)]"
              style={{
                left: position.x + 6,
                top: Math.max(4, position.y + 5),
                maxWidth: `${maxLabelWidth}px`,
                color: "var(--app-text-primary)",
                background: "color-mix(in srgb, var(--app-panel-bg) 82%, transparent)",
                borderColor: color,
                borderRadius: 3,
              }}
              data-flow-binding-id={bindingId}
              onClick={(clickEvent) => {
                clickEvent.stopPropagation();
                navigate(node);
              }}
            >
              <span
                className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ background: color }}
                aria-hidden="true"
              />
              <span className="align-middle">{node.label}</span>
              {summary && summary !== node.label ? (
                <span className="ml-1 align-middle text-[var(--app-text-secondary)]">{summary}</span>
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
