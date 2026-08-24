import { edgeCurve, edgePath, visibleEdges } from "@/lib/canvasGeometry";
import type { CanvasNodePosition, PipeEdge, PipeEvent, PipeEventPhase } from "@/types/canvas";

interface PipeSvgLayerProps {
  edges: PipeEdge[];
  positions: Record<string, CanvasNodePosition>;
  events?: PipeEvent[];
}

function eventEndpoint(event: PipeEvent, side: "source" | "target"): string | undefined {
  if (side === "source") {
    return event.sourceId
      ?? (event.fromBinding ? `binding:${event.fromBinding}` : undefined)
      ?? (event.fromSession ? `session:${event.fromSession}` : undefined);
  }
  return event.targetId
    ?? (event.toBinding ? `binding:${event.toBinding}` : undefined)
    ?? (event.toSession ? `session:${event.toSession}` : undefined);
}

function eventEndpoints(event: PipeEvent): [string, string] | null {
  const source = eventEndpoint(event, "source");
  const target = eventEndpoint(event, "target");
  return source && target ? [source, target] : null;
}

function latestEdgeEvent(edge: PipeEdge, events: PipeEvent[]): PipeEvent | undefined {
  return events
    .filter((event) => {
      const endpoints = eventEndpoints(event);
      if (!endpoints) return false;
      const [source, target] = endpoints;
      return (source === edge.sourceId && target === edge.targetId)
        || (source === edge.targetId && target === edge.sourceId);
    })
    .sort((left, right) => right.sequence - left.sequence)[0];
}

function phaseColor(phase: PipeEventPhase | "idle"): string {
  switch (phase) {
    case "queued": return "var(--app-status-warning)";
    case "delivered": return "var(--app-status-success)";
    case "failed": return "var(--app-status-danger)";
    case "flowing": return "var(--app-canvas-pipe-primary)";
    default: return "var(--app-canvas-pipe-primary)";
  }
}

function markerId(phase: PipeEventPhase | "idle"): string {
  switch (phase) {
    case "queued": return "canvas-pipe-arrow-warning";
    case "delivered": return "canvas-pipe-arrow-success";
    case "failed": return "canvas-pipe-arrow-danger";
    default: return "canvas-pipe-arrow-accent";
  }
}

function gradientId(phase: PipeEventPhase | "idle"): string {
  switch (phase) {
    case "queued": return "canvas-pipe-core-warning";
    case "delivered": return "canvas-pipe-core-success";
    case "failed": return "canvas-pipe-core-danger";
    default: return "canvas-pipe-core-accent";
  }
}

export function resolvePipePhase(edge: PipeEdge, events: PipeEvent[]): PipeEventPhase | "idle" {
  return latestEdgeEvent(edge, events)?.phase ?? "idle";
}

export default function PipeSvgLayer({ edges, positions, events = [] }: PipeSvgLayerProps) {
  const paths = visibleEdges(edges, positions);
  return (
    <svg
      className="pointer-events-none absolute inset-0 z-[1] h-full w-full overflow-visible"
      aria-hidden="true"
      focusable="false"
      data-canvas-pipe-count={paths.length}
      style={{ overflow: "visible" }}
    >
      <defs>
        {[
          ["accent", "var(--app-canvas-pipe-primary)"],
          ["warning", "var(--app-status-warning)"],
          ["success", "var(--app-status-success)"],
          ["danger", "var(--app-status-danger)"],
        ].map(([name, color]) => (
          <marker
            key={name}
            id={`canvas-pipe-arrow-${name}`}
            markerWidth="5.5"
            markerHeight="5.5"
            refX="5"
            refY="2.75"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M 0 0 L 5.5 2.75 L 0 5.5 Z" fill={color} />
          </marker>
        ))}
        {[
          ["accent", "var(--app-canvas-pipe-primary)"],
          ["warning", "var(--app-status-warning)"],
          ["success", "var(--app-status-success)"],
          ["danger", "var(--app-status-danger)"],
        ].map(([name, color]) => (
          <linearGradient key={`core-${name}`} id={`canvas-pipe-core-${name}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="18%" stopColor={color} stopOpacity="0.9" />
            <stop offset="52%" stopColor={color} stopOpacity="1" />
            <stop offset="100%" stopColor={color} stopOpacity="0.5" />
          </linearGradient>
        ))}
        <filter id="canvas-pipe-soft-glow" x="-35%" y="-45%" width="170%" height="190%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.3" result="canvasPipeBlur" />
          <feMerge>
            <feMergeNode in="canvasPipeBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {paths.map((edge) => (
        (() => {
          const event = latestEdgeEvent(edge, events);
          const phase = event?.phase ?? "idle";
          const endpoints = event ? eventEndpoints(event) : null;
          const source = (endpoints && positions[endpoints[0]]) || positions[edge.sourceId];
          const target = (endpoints && positions[endpoints[1]]) || positions[edge.targetId];
          if (!source || !target) return null;
          const curve = edgeCurve(source, target);
          const path = edgePath(source, target);
          const color = phaseColor(phase);
          // Keep the image-one treatment throughout the link lifecycle, but
          // use compact dimensions so the relationship never reads as a tube.
          const auraWidth = 5;
          const casingWidth = 1.8;
          const pathWidth = 1.1;
          const portAuraRadius = 5.5;
          const portRingRadius = 3.6;
          const portOrbitRadius = 2.5;
          const portCoreRadius = 1.4;
          const portSparkRadius = 0.55;
          return (
            <g
              key={`${edge.id}:${event?.eventId ?? "idle"}:${phase}`}
              className={`canvas-pipe canvas-pipe-state-${phase}`}
              data-canvas-pipe-phase={phase}
              data-canvas-pipe-active="true"
              style={{ color }}
            >
              {/* This is a relationship track rather than a literal tube: a fine
                  route line, a moving dash lane, and small endpoint markers. */}
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeOpacity="0.14"
                strokeWidth={auraWidth}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                filter="url(#canvas-pipe-soft-glow)"
                className="canvas-pipe-aura"
              />
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeOpacity="0.2"
                strokeWidth={casingWidth}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="canvas-pipe-casing"
              />
              <path
                d={path}
                fill="none"
                stroke="var(--app-canvas-pipe-channel)"
                strokeOpacity="0.5"
                strokeWidth="0.7"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className="canvas-pipe-channel"
              />
              <path
                d={path}
                fill="none"
                stroke={`url(#${gradientId(phase)})`}
                strokeOpacity="0.84"
                strokeWidth={pathWidth}
                strokeLinecap="round"
                markerEnd={`url(#${markerId(phase)})`}
                vectorEffect="non-scaling-stroke"
                className={`canvas-pipe-path canvas-pipe-underlay canvas-pipe-${phase}`}
              />
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeOpacity="0.92"
                strokeWidth="1.15"
                strokeDasharray="10 8"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className={`canvas-pipe-signal canvas-pipe-${phase}`}
              />
              <path
                d={path}
                fill="none"
                stroke={color}
                strokeOpacity="0.52"
                strokeWidth="0.7"
                strokeDasharray="1 28"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                filter="url(#canvas-pipe-soft-glow)"
                className={`canvas-pipe-energy-lane canvas-pipe-${phase}`}
              />
              <path
                d={path}
                fill="none"
                stroke="var(--app-canvas-pipe-highlight)"
                strokeOpacity="0.38"
                strokeWidth="0.35"
                strokeDasharray="1 44"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                className={`canvas-pipe-spark-lane canvas-pipe-${phase}`}
              />
              <g className="canvas-pipe-port">
                <circle cx={curve.startX} cy={curve.startY} r={portAuraRadius} fill="none" stroke={color} strokeOpacity="0.22" strokeWidth="0.9" className="canvas-pipe-port-aura" />
                <circle cx={curve.startX} cy={curve.startY} r={portRingRadius} fill="var(--app-canvas-pipe-channel)" stroke={color} strokeWidth="1.15" className="canvas-pipe-port-ring" />
                <circle cx={curve.startX} cy={curve.startY} r={portOrbitRadius} fill="none" stroke={color} strokeOpacity="0.8" strokeWidth="0.75" strokeDasharray="1.8 2.7" className="canvas-pipe-port-orbit" />
                <circle cx={curve.startX} cy={curve.startY} r={portCoreRadius} fill={color} fillOpacity="0.96" className="canvas-pipe-port-core" />
                <circle cx={curve.startX} cy={curve.startY} r={portSparkRadius} fill="var(--app-canvas-pipe-highlight)" className="canvas-pipe-port-spark" />
              </g>
              <g className="canvas-pipe-port">
                <circle cx={curve.endX} cy={curve.endY} r={portAuraRadius} fill="none" stroke={color} strokeOpacity="0.22" strokeWidth="0.9" className="canvas-pipe-port-aura" />
                <circle cx={curve.endX} cy={curve.endY} r={portRingRadius} fill="var(--app-canvas-pipe-channel)" stroke={color} strokeWidth="1.15" className="canvas-pipe-port-ring" />
                <circle cx={curve.endX} cy={curve.endY} r={portOrbitRadius} fill="none" stroke={color} strokeOpacity="0.8" strokeWidth="0.75" strokeDasharray="1.8 2.7" className="canvas-pipe-port-orbit" />
                <circle cx={curve.endX} cy={curve.endY} r={portCoreRadius} fill={color} fillOpacity="0.96" className="canvas-pipe-port-core" />
                <circle cx={curve.endX} cy={curve.endY} r={portSparkRadius} fill="var(--app-canvas-pipe-highlight)" className="canvas-pipe-port-spark" />
              </g>
            </g>
          );
        })()
      ))}
    </svg>
  );
}
