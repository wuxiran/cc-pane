import { create } from "zustand";
import type { CanvasNodePosition, CanvasNodeProjection, CanvasSnapshot, CanvasSnapshotScope, PipeEvent } from "@/types/canvas";
import {
  isTerminalPipeEventPhase,
  PIPE_EVENT_TERMINAL_TTL_MS,
  prunePipeEvents,
  reducePipeEvents,
  type PipeEventAction,
} from "@/lib/pipeEventReducer";
import { canvasSnapshotService } from "@/services/canvasSnapshotService";
import { useCanvasDisplayStore } from "./useCanvasDisplayStore";

interface CanvasState {
  nodes: CanvasNodeProjection[];
  events: PipeEvent[];
  snapshot: CanvasSnapshot | null;
  nodePositions: Record<string, CanvasNodePosition>;
  manualNodeIds: Record<string, true>;
  /** Positions loaded before the async projection has registered every node. */
  pendingRestoreNodeIds: Record<string, true>;
  positionScopeKey: string | null;
  setNodes: (nodes: CanvasNodeProjection[]) => void;
  setNodePosition: (nodeId: string, position: CanvasNodePosition) => void;
  dispatchPipeEvent: (action: PipeEventAction) => void;
  saveSnapshot: (scope: CanvasSnapshotScope, partial?: Partial<Omit<CanvasSnapshot, "workspaceId" | "layoutId">>) => CanvasSnapshot;
  loadSnapshot: (scope: CanvasSnapshotScope) => CanvasSnapshot | null;
}

const DEFAULT_DISPLAY_MODE = "panel" as const;
const DEFAULT_ANIMATION_INTENSITY = "full" as const;

function scopeKey(scope: CanvasSnapshotScope): string {
  return JSON.stringify([scope.workspaceId, scope.layoutId]);
}

function mergeNodePositions(
  nodes: CanvasNodeProjection[],
  positions: Record<string, CanvasNodePosition> = {},
): CanvasNodeProjection[] {
  return nodes.map((node) => {
    // Automatic coordinates belong to the current viewport and must never be
    // copied back into the store. Only explicit drag/resize coordinates are
    // stable across a resize or a layout switch.
    const position = positions[node.id];
    const { position: _automaticPosition, ...withoutPosition } = node;
    return position ? { ...withoutPosition, position } : withoutPosition;
  });
}

export const useCanvasStore = create<CanvasState>((set, get) => {
  let eventPruneTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleEventPrune = (events: PipeEvent[]) => {
    if (eventPruneTimer !== null) clearTimeout(eventPruneTimer);
    const terminalEvents = events.filter((event) => isTerminalPipeEventPhase(event.phase));
    if (terminalEvents.length === 0) {
      eventPruneTimer = null;
      return;
    }
    const now = Date.now();
    const nextExpiry = terminalEvents.reduce((earliest, event) => {
      const createdAt = Date.parse(event.createdAt);
      const expiry = Number.isFinite(createdAt) ? createdAt + PIPE_EVENT_TERMINAL_TTL_MS : now + PIPE_EVENT_TERMINAL_TTL_MS;
      return Math.min(earliest, expiry);
    }, Number.POSITIVE_INFINITY);
    eventPruneTimer = setTimeout(() => {
      eventPruneTimer = null;
      set((state) => {
        const eventsAfterPrune = prunePipeEvents(state.events);
        scheduleEventPrune(eventsAfterPrune);
        return { events: eventsAfterPrune };
      });
    }, Math.max(0, nextExpiry - now));
  };

  return {
    nodes: [],
    events: [],
    snapshot: null,
    nodePositions: {},
    manualNodeIds: {},
    pendingRestoreNodeIds: {},
    positionScopeKey: null,
    setNodes: (nodes) => set((state) => {
      const visibleIds = new Set(nodes.map((node) => node.id));
      // The projection is populated asynchronously after the snapshot load.
      // Keep explicit coordinates until their node appears; otherwise the
      // first empty projection would replace the saved canvas with defaults.
      const pendingRestoreNodeIds = Object.fromEntries(
        Object.keys(state.pendingRestoreNodeIds)
          .filter((id) => !visibleIds.has(id))
          .map((id) => [id, true as const]),
      );
      return {
        nodes: mergeNodePositions(nodes, state.nodePositions),
        nodePositions: state.nodePositions,
        manualNodeIds: state.manualNodeIds,
        pendingRestoreNodeIds,
      };
    }),
    setNodePosition: (nodeId, position) => set((state) => {
      const nodePositions = { ...state.nodePositions, [nodeId]: position };
      const pendingRestoreNodeIds = { ...state.pendingRestoreNodeIds };
      delete pendingRestoreNodeIds[nodeId];
      return {
        nodePositions,
        manualNodeIds: { ...state.manualNodeIds, [nodeId]: true },
        pendingRestoreNodeIds,
        nodes: state.nodes.map((node) => node.id === nodeId ? { ...node, position } : node),
      };
    }),
    dispatchPipeEvent: (action) => set((state) => {
      const next = reducePipeEvents({ events: state.events }, action);
      scheduleEventPrune(next.events);
      return next;
    }),
    saveSnapshot: (scope, partial = {}) => {
      const previous = get().snapshot;
      const sourceNodes = partial.nodes ?? get().nodes;
      const sourceIds = new Set(sourceNodes.map((node) => node.id));
      const customizedNodeIds = [...new Set(
        partial.customizedNodeIds ?? Object.keys(get().manualNodeIds),
      )].filter((id) => sourceIds.has(id));
      const customized = new Set(customizedNodeIds);
      const persistedNodes = sourceNodes.map((node) => {
        if (customized.has(node.id)) return node;
        const { position: _position, ...withoutAutomaticPosition } = node;
        return withoutAutomaticPosition;
      });
      const snapshot: CanvasSnapshot = {
        version: 1,
        workspaceId: scope.workspaceId,
        layoutId: scope.layoutId,
        savedAt: new Date().toISOString(),
        displayMode: previous?.displayMode ?? DEFAULT_DISPLAY_MODE,
        ...partial,
        // Animation intensity is no longer user-selectable. Keep the field
        // for snapshot compatibility, but always migrate saved data to full.
        animationIntensity: DEFAULT_ANIMATION_INTENSITY,
        nodes: persistedNodes,
        customizedNodeIds,
      };
      canvasSnapshotService.save(scope, snapshot);
      set({
        snapshot,
        positionScopeKey: scopeKey(scope),
        nodePositions: Object.fromEntries(
          snapshot.nodes.flatMap((node) => customized.has(node.id) && node.position ? [[node.id, node.position]] : []),
        ),
        manualNodeIds: Object.fromEntries(customizedNodeIds.map((id) => [id, true])),
        pendingRestoreNodeIds: {},
      });
      return snapshot;
    },
    loadSnapshot: (scope) => {
      const snapshot = canvasSnapshotService.load(scope);
      if (snapshot) {
        useCanvasDisplayStore.getState().setMode(snapshot.displayMode);
      }
      // Older snapshots may contain reduced/off, but Canvas now always uses
      // the complete animation preset.
      useCanvasDisplayStore.getState().setAnimationIntensity(DEFAULT_ANIMATION_INTENSITY);
      // Snapshots written before customizedNodeIds existed only contain
      // automatic coordinates. Do not re-import those as user positions: they
      // may have been measured while the normal pane surface was hidden.
      const customized = new Set(
        snapshot?.customizedNodeIds ?? [],
      );
      const savedPositions = Object.fromEntries(
        snapshot?.nodes.flatMap((node) => customized.has(node.id) && node.position ? [[node.id, node.position]] : []) ?? [],
      );
      set((state) => ({
        snapshot,
        positionScopeKey: scopeKey(scope),
        nodePositions: savedPositions,
        // The projection effect may register nodes after this load effect. Keep
        // explicit ids now; setNodes() filters them once live nodes are present.
        manualNodeIds: Object.fromEntries([...customized].map((id) => [id, true])),
        pendingRestoreNodeIds: Object.fromEntries([...customized].map((id) => [id, true as const])),
        nodes: mergeNodePositions(
          state.nodes.map(({ position: _position, ...node }) => node),
          savedPositions,
        ),
      }));
      return snapshot;
    },
  };
});
