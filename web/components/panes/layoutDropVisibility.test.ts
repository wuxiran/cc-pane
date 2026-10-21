import { rectIntersection, type ClientRect, type CollisionDetection, type DroppableContainer } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vitest";
import { detectPaneDropCollisions } from "./layoutDropVisibility";
import { resolveDndDrop, type PaneDndContextData } from "./paneDndRouting";

type CollisionArgs = Parameters<CollisionDetection>[0];
const rect = (left: number, width: number, top = 100, height = 64): ClientRect =>
  ({ left, right: left + width, top, bottom: top + height, width, height });
const context: PaneDndContextData = {
  panels: [{ id: "pane-2", tabs: [] }],
  layouts: [{ id: "current" }, { id: "visible" }, { id: "hidden" }, { id: "corner" }],
  currentLayoutId: "current",
};

function viewport(bounds = rect(300, 400)) {
  const node = document.createElement("div");
  node.dataset.layoutScrollViewport = "";
  const measure = vi.spyOn(node, "getBoundingClientRect").mockReturnValue(bounds as DOMRect);
  return { node, measure };
}

function target(id: string, bounds: ClientRect, parent?: HTMLElement,
  data: Record<string, unknown> = { type: "layout", layoutId: id }): DroppableContainer {
  const node = document.createElement("div");
  parent?.appendChild(node);
  return { id, key: id, disabled: false, data: { current: data }, node: { current: node }, rect: { current: bounds } };
}

function args(targets: DroppableContainer[], collisionRect = rect(610, 80, 110, 40),
  pointerCoordinates: CollisionArgs["pointerCoordinates"] = { x: 650, y: 130 },
  activeType = "tab"): CollisionArgs {
  return {
    active: { id: activeType === "layout" ? "current" : "tab-1", data: { current: { type: activeType, paneId: "pane-1" } },
      rect: { current: { initial: collisionRect, translated: collisionRect } } },
    collisionRect, pointerCoordinates, droppableContainers: targets,
    droppableRects: new Map(targets.map((item) => [item.id, item.rect.current!])),
  };
}

function route(input: CollisionArgs, collisionDetection = detectPaneDropCollisions) {
  const over = collisionDetection(input)[0];
  const container = input.droppableContainers.find((item) => item.id === over?.id);
  return resolveDndDrop(
    { id: String(input.active.id), data: input.active.data.current },
    container ? { id: String(container.id), data: container.data.current } : null,
    context,
  );
}

describe("layout scroll viewport drop visibility", () => {
  it("does not move a terminal into a hidden card behind the fixed right tools", () => {
    const strip = viewport();
    const input = args([target("hidden", rect(704, 200), strip.node)], rect(710, 120, 114, 40), { x: 720, y: 130 });
    // Reproduce the original bug through the actual collision algorithm and route.
    expect(route(input, rectIntersection)).toEqual({
      kind: "move-tab-to-layout", fromPaneId: "pane-1", tabId: "tab-1", toLayoutId: "hidden",
    });
    expect(route(input)).toBeNull();
  });

  it("rejects fully clipped cards even when a wide dragged tab overlaps them from inside the viewport", () => {
    const strip = viewport();
    const input = args([target("hidden", rect(704, 200), strip.node)], rect(600, 250, 114, 40));
    expect(route(input, rectIntersection)).not.toBeNull();
    expect(route(input)).toBeNull();
  });

  it.each([{ x: 299, y: 130 }, { x: 700, y: 130 }, { x: 650, y: 99 }, { x: 650, y: 164 }])(
    "rejects a strip target when the pointer is outside its viewport at $x,$y", (pointer) => {
      const strip = viewport();
      const input = args([target("visible", rect(250, 500), strip.node)], rect(610, 80, 110, 40), pointer);
      expect(route(input, rectIntersection)).not.toBeNull();
      expect(route(input)).toBeNull();
    },
  );

  it("accepts a partially visible card using only its clipped rectangle, without mutating dnd-kit measurements", () => {
    const strip = viewport();
    const card = target("visible", rect(650, 200), strip.node);
    const input = args([card], rect(670, 80, 110, 40), { x: 675, y: 130 });
    const originalRect = input.droppableRects.get("visible");
    const expected = rectIntersection({ ...input, droppableRects: new Map([["visible", rect(650, 50)]]) });
    expect(detectPaneDropCollisions(input)).toEqual(expected);
    expect(route(input)).toEqual({
      kind: "move-tab-to-layout", fromPaneId: "pane-1", tabId: "tab-1", toLayoutId: "visible",
    });
    expect(input.droppableRects.get("visible")).toBe(originalRect);
    expect(originalRect?.right).toBe(850);
    expect(input.droppableContainers).toEqual([card]);
  });

  it("retains closest-center layout reordering within the viewport", () => {
    const strip = viewport();
    const input = args([
      target("visible", rect(500, 200), strip.node), target("hidden", rect(704, 200), strip.node),
    ], rect(610, 80, 110, 40), { x: 650, y: 130 }, "layout");
    expect(route(input)).toEqual({ kind: "reorder-layouts", fromIndex: 0, toIndex: 1 });
  });

  it("allows pointerless collision detection while still excluding hidden cards", () => {
    const strip = viewport();
    const input = args([
      target("visible", rect(500, 200), strip.node), target("hidden", rect(704, 200), strip.node),
    ], rect(720, 80, 110, 40), null, "layout");
    expect(route(input)).toEqual({ kind: "reorder-layouts", fromIndex: 0, toIndex: 1 });
  });

  it("keeps corner layouts and ordinary pane edge targets outside the strip unchanged", () => {
    const strip = viewport();
    const hidden = target("hidden", rect(704, 200), strip.node);
    const input = args([hidden, target("corner", rect(704, 200))], rect(710, 120, 114, 40), { x: 720, y: 130 });
    expect(route(input)).toEqual({
      kind: "move-tab-to-layout", fromPaneId: "pane-1", tabId: "tab-1", toLayoutId: "corner",
    });
    const edge = target("edge", rect(704, 200), undefined, { type: "pane-edge", paneId: "pane-2", edge: "right" });
    expect(route(args([hidden, edge], input.collisionRect, input.pointerCoordinates))).toEqual({
      kind: "split-move-tab", fromPaneId: "pane-1", toPaneId: "pane-2", tabId: "tab-1", edge: "right",
    });
  });

  it("measures a shared viewport once per collision and refreshes bounds after a resize", () => {
    const strip = viewport();
    const input = args([
      target("visible", rect(500, 200), strip.node), target("hidden", rect(704, 200), strip.node),
    ], rect(750, 80, 110, 40), { x: 790, y: 130 });
    expect(route(input)).toBeNull();
    expect(strip.measure).toHaveBeenCalledTimes(1);
    strip.measure.mockReturnValue(rect(300, 600) as DOMRect);
    expect(route(input)).toEqual({
      kind: "move-tab-to-layout", fromPaneId: "pane-1", tabId: "tab-1", toLayoutId: "hidden",
    });
    expect(strip.measure).toHaveBeenCalledTimes(2);
  });
});
