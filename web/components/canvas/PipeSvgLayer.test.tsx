import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PipeSvgLayer, { resolvePipePhase } from "./PipeSvgLayer";
import { edgePath } from "@/lib/canvasGeometry";
import type { PipeEvent } from "@/types/canvas";

const edge = { id: "pipe:source->target", sourceId: "source", targetId: "target", readOnly: true as const };
const positions = {
  source: { x: 0, y: 0, width: 40, height: 30 },
  target: { x: 180, y: 80, width: 40, height: 30 },
};

function event(phase: PipeEvent["phase"]): PipeEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${phase}`,
    correlationId: "correlation-1",
    sequence: phase === "flowing" ? 2 : 1,
    workspaceId: "workspace-1",
    kind: "message",
    phase,
    sourceId: "source",
    targetId: "target",
    summary: phase,
    createdAt: "2026-08-24T00:00:00.000Z",
  };
}

describe("PipeSvgLayer", () => {
  it("draws an arrow and reflects the latest transport phase", () => {
    const { container } = render(<PipeSvgLayer edges={[edge]} positions={positions} events={[event("flowing")]} />);
    const path = container.querySelector("path.canvas-pipe-flowing");

    expect(path).toHaveAttribute("marker-end", "url(#canvas-pipe-arrow-accent)");
    expect(container.querySelector("path.canvas-pipe-aura")).toBeInTheDocument();
    expect(container.querySelector("path.canvas-pipe-casing")).toBeInTheDocument();
    expect(container.querySelector("path.canvas-pipe-channel")).toBeInTheDocument();
    expect(container.querySelector("path.canvas-pipe-signal.canvas-pipe-flowing"))
      .toHaveAttribute("stroke", "var(--app-canvas-pipe-primary)");
    expect(container.querySelector("path.canvas-pipe-signal.canvas-pipe-flowing"))
      .toHaveAttribute("stroke-dasharray", "10 8");
    expect(container.querySelector("path.canvas-pipe-channel"))
      .toHaveAttribute("stroke", "var(--app-canvas-pipe-channel)");
    expect(container.querySelector("path.canvas-pipe-spark-lane.canvas-pipe-flowing"))
      .toHaveAttribute("stroke", "var(--app-canvas-pipe-highlight)");
    expect(container.querySelector("path.canvas-pipe-energy-lane.canvas-pipe-flowing")).toHaveAttribute("stroke-dasharray", "1 28");
    expect(container.querySelectorAll("circle.canvas-pipe-port-ring")).toHaveLength(2);
    expect(container.querySelectorAll("circle.canvas-pipe-port-aura")).toHaveLength(2);
    expect(resolvePipePhase(edge, [event("flowing")])).toBe("flowing");
  });

  it("routes a reverse report event along the same parent-child pipe", () => {
    const reverse = {
      ...event("flowing"),
      eventId: "event-report-flowing",
      kind: "report" as const,
      sourceId: "target",
      targetId: "source",
    };
    const { container } = render(<PipeSvgLayer edges={[edge]} positions={positions} events={[reverse]} />);
    const path = container.querySelector("path.canvas-pipe-flowing");

    expect(path).toHaveAttribute("d", edgePath(positions.target, positions.source));
    expect(resolvePipePhase(edge, [reverse])).toBe("flowing");
  });

  it("keeps the compact image-one treatment across transport phases", () => {
    const { container, rerender } = render(
      <PipeSvgLayer edges={[edge]} positions={positions} events={[event("flowing")]} />,
    );
    const flowing = container.querySelector("g.canvas-pipe-state-flowing");
    expect(flowing).toHaveAttribute("data-canvas-pipe-active", "true");
    expect(container.querySelector("circle.canvas-pipe-port-ring")).toHaveAttribute("r", "3.6");

    rerender(<PipeSvgLayer edges={[edge]} positions={positions} events={[event("delivered")]} />);
    const settled = container.querySelector("g.canvas-pipe-state-delivered");
    expect(settled).toHaveAttribute("data-canvas-pipe-active", "true");
    expect(container.querySelector("circle.canvas-pipe-port-ring")).toHaveAttribute("r", "3.6");
  });
});
