import { closestCenter, rectIntersection, type ClientRect, type CollisionDetection } from "@dnd-kit/core";

type CollisionArgs = Parameters<CollisionDetection>[0];

function intersectRect(rect: ClientRect, viewport: ClientRect): ClientRect | null {
  const left = Math.max(rect.left, viewport.left);
  const top = Math.max(rect.top, viewport.top);
  const right = Math.min(rect.right, viewport.right);
  const bottom = Math.min(rect.bottom, viewport.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function visibleLayoutTargets(args: CollisionArgs): CollisionArgs {
  const viewportRects = new Map<HTMLElement, ClientRect>();
  const droppableRects = new Map(args.droppableRects);
  const droppableContainers = args.droppableContainers.filter((container) => {
    if (container.data.current?.type !== "layout") return true;
    const viewport = container.node.current?.closest<HTMLElement>("[data-layout-scroll-viewport]");
    // Corner layouts and ordinary pane targets keep their existing behavior.
    if (!viewport) return true;
    let bounds = viewportRects.get(viewport);
    if (!bounds) {
      bounds = viewport.getBoundingClientRect();
      viewportRects.set(viewport, bounds);
    }
    const pointer = args.pointerCoordinates;
    if (pointer && (pointer.x < bounds.left || pointer.x >= bounds.right
      || pointer.y < bounds.top || pointer.y >= bounds.bottom)) return false;
    const rect = args.droppableRects.get(container.id);
    const visible = rect && intersectRect(rect, bounds);
    if (!visible) return false;
    // dnd-kit measures un-clipped bounds, including cards behind fixed tools.
    // Use a separate map so scrolling/measuring never consumes our clipped rects.
    droppableRects.set(container.id, visible);
    return true;
  });
  return { ...args, droppableRects, droppableContainers };
}

/** Preserve each drag type's collision strategy, restricted to visible layout cards. */
export const detectPaneDropCollisions: CollisionDetection = (args) => {
  const visible = visibleLayoutTargets(args);
  return args.active.data.current?.type === "layout" ? closestCenter(visible) : rectIntersection(visible);
};
