import { describe, expect, it } from "vitest";
import { canvasNodeMinimumSize, defaultCanvasPositions, edgePath, rectToCanvasPosition, visibleEdges } from "./canvasGeometry";
import type { CanvasNodeProjection } from "@/types/canvas";

describe("canvasGeometry", () => {
  it("converts a DOM rect relative to the overlay", () => {
    expect(rectToCanvasPosition({ left: 30, top: 40, width: 100, height: 50 }, { left: 10, top: 20, width: 500, height: 400 })).toEqual({ x: 20, y: 20, width: 100, height: 50 });
  });

  it("creates a cubic path and hides edges without both positions", () => {
    const source = { x: 0, y: 0, width: 20, height: 10 };
    const target = { x: 100, y: 50, width: 20, height: 10 };
    expect(edgePath(source, target)).toContain("C");
    expect(visibleEdges([{ id: "e", sourceId: "a", targetId: "b", readOnly: true }], { a: source })).toEqual([]);
  });

  it("uses responsive sizes and a worker grid for the leader tree", () => {
    const nodes: CanvasNodeProjection[] = [
      { id: "leader", label: "Leader", kind: "task", role: "leader", status: "running" },
      { id: "worker-1", label: "Worker 1", kind: "task", role: "worker", parentId: "leader", status: "pending" },
      { id: "worker-2", label: "Worker 2", kind: "task", role: "worker", parentId: "leader", status: "pending" },
      { id: "worker-3", label: "Worker 3", kind: "task", role: "worker", parentId: "leader", status: "pending" },
    ];
    const compact = defaultCanvasPositions(nodes, 640, 480);
    const wide = defaultCanvasPositions(nodes, 1440, 900);

    expect(compact.leader.width).toBeGreaterThan(compact["worker-1"].width);
    expect(compact.leader.height).toBeGreaterThan(compact["worker-1"].height);
    expect(compact["worker-1"].x).toBeGreaterThan(compact.leader.x);
    expect(compact["worker-2"].x).toBeGreaterThan(compact["worker-1"].x);
    expect(compact["worker-3"].y).toBeGreaterThan(compact["worker-1"].y);
    expect(wide.leader.width).not.toBe(compact.leader.width);
    expect(wide.leader.height).not.toBe(compact.leader.height);
  });

  it("keeps a desktop pair readable and inside the first viewport", () => {
    const nodes: CanvasNodeProjection[] = [
      { id: "leader", label: "Leader", kind: "terminal", tabId: "tab-leader", status: "running" },
      { id: "worker", label: "Worker", kind: "terminal", tabId: "tab-worker", parentTabId: "tab-leader", status: "running" },
    ];
    const positions = defaultCanvasPositions(nodes, 2200, 1450);

    expect(positions.leader.width).toBeLessThanOrEqual(900);
    expect(positions.leader.height).toBeLessThanOrEqual(620);
    expect(positions.worker.width).toBeLessThanOrEqual(660);
    expect(positions.worker.width).toBeGreaterThan(500);
    expect(positions.leader.width).toBeGreaterThan(positions.worker.width);
    expect(positions.worker.x).toBeGreaterThan(positions.leader.x);
    expect(positions.worker.y).toBeGreaterThanOrEqual(24);
    expect(positions.worker.y + positions.worker.height).toBeLessThanOrEqual(1450 - 24);
  });

  it("uses the sole leader as the parent when older workers lack parentId", () => {
    const nodes: CanvasNodeProjection[] = [
      { id: "leader", label: "Leader", kind: "task", role: "leader", status: "running" },
      { id: "worker-1", label: "Worker 1", kind: "task", role: "worker", status: "running" },
      { id: "worker-2", label: "Worker 2", kind: "task", role: "worker", status: "running" },
    ];
    const positions = defaultCanvasPositions(nodes, 1400, 900);

    expect(positions["worker-1"].x).toBeGreaterThan(positions.leader.x);
    expect(positions["worker-2"].x).toBeGreaterThan(positions.leader.x);
    expect(
      positions["worker-2"].x !== positions["worker-1"].x
        || positions["worker-2"].y !== positions["worker-1"].y,
    ).toBe(true);
  });

  it("keeps media cards inside a narrow viewport while preserving a readable minimum", () => {
    const media: CanvasNodeProjection = {
      id: "media:narrow",
      label: "Preview",
      kind: "media",
      status: "running",
      media: { mediaKind: "video", runStatus: "processing" },
    };
    const positions = defaultCanvasPositions([media], 360, 240);
    const minimum = canvasNodeMinimumSize(media, 360, 240, new Set([media.id]));

    expect(positions[media.id].width).toBeLessThanOrEqual(328);
    expect(positions[media.id].height).toBeLessThanOrEqual(208);
    expect(minimum.width).toBeLessThanOrEqual(328);
    expect(minimum.height).toBeLessThanOrEqual(208);
  });
});
