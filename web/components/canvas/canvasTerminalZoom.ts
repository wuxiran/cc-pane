import {
  TERMINAL_FONT_SIZE_DEFAULT,
  normalizeTerminalFontSize,
} from "@/stores";
import type { CanvasNodeProjection } from "@/types/canvas";

/** Canvas starts with a compact but readable terminal scale. */
export const CANVAS_TERMINAL_INITIAL_ZOOM_PERCENT = 67;
export const CANVAS_TERMINAL_INITIAL_FONT_SIZE = normalizeTerminalFontSize(
  Math.round(TERMINAL_FONT_SIZE_DEFAULT * CANVAS_TERMINAL_INITIAL_ZOOM_PERCENT / 100),
);

/**
 * Keep a user's Canvas zoom attached to the logical terminal, rather than to
 * a React mount. Binding and leaf ids survive layout changes and app restore;
 * session ids are a fallback for older projections without either identity.
 */
export function canvasTerminalZoomPersistenceKey(node: CanvasNodeProjection): string {
  const identity = node.bindingId
    ? `binding:${node.bindingId}`
    : node.leafId
      ? `leaf:${node.leafId}`
      : node.tabId
        ? `tab:${node.tabId}`
        : node.sessionId
          ? `session:${node.sessionId}`
          : node.id;
  return `canvas-terminal:${identity}`;
}
