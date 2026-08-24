import type { CanvasSnapshot, CanvasSnapshotScope } from "@/types/canvas";

// Previous namespaces contain coordinates from compact, viewport-sized layouts.
// Keep them isolated so the first view uses the current responsive geometry;
// explicit drag/resize positions written by this layout use v6.
const STORAGE_KEY = "cc-panes-canvas-snapshot-v6";

function storageKey(scope: CanvasSnapshotScope): string {
  return `${STORAGE_KEY}:${encodeURIComponent(JSON.stringify([scope.workspaceId, scope.layoutId]))}`;
}

export const canvasSnapshotService = {
  load(scope: CanvasSnapshotScope): CanvasSnapshot | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey(scope));
      if (!raw) return null;
      const value = JSON.parse(raw) as CanvasSnapshot;
      return value?.version === 1
        && value.workspaceId === scope.workspaceId
        && value.layoutId === scope.layoutId
        ? value
        : null;
    } catch {
      return null;
    }
  },
  save(scope: CanvasSnapshotScope, snapshot: CanvasSnapshot): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey(scope), JSON.stringify(snapshot));
    } catch {
      // Restricted webviews may deny storage; callers retain the in-memory snapshot.
    }
  },
  clear(scope: CanvasSnapshotScope): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(storageKey(scope));
    } catch {
      // Storage failure does not affect the running canvas.
    }
  },
};
