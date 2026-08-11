import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { registerSessionScopedResource } from "@/lib/tabLifecycle/sessionScopedResources";
import { taskQueueService } from "@/services/taskQueueService";
import type {
  StagedTaskQueueImage,
  TaskQueueControlPatch,
  TaskQueueItemDraft,
  TaskQueueSnapshot,
} from "@/types/taskQueue";
import { translateError } from "@/utils/errorTranslation";

interface TaskQueueState {
  snapshots: Map<string, TaskQueueSnapshot>;
  loadingSessions: Set<string>;
  mutatingSessions: Set<string>;
  errors: Map<string, string>;
  _initialized: boolean;
  _unlisten: UnlistenFn | null;
  initialize: () => Promise<void>;
  cleanup: () => void;
  dropSession: (sessionId: string) => void;
  load: (sessionId: string) => Promise<TaskQueueSnapshot | undefined>;
  applySnapshot: (snapshot: TaskQueueSnapshot) => void;
  stageClipboardImage: (sessionId: string) => Promise<StagedTaskQueueImage>;
  addItem: (sessionId: string, draft: TaskQueueItemDraft) => Promise<TaskQueueSnapshot>;
  deleteItem: (sessionId: string, itemId: string) => Promise<TaskQueueSnapshot>;
  clear: (sessionId: string) => Promise<TaskQueueSnapshot>;
  update: (sessionId: string, patch: TaskQueueControlPatch) => Promise<TaskQueueSnapshot>;
  retry: (sessionId: string, itemId: string) => Promise<TaskQueueSnapshot>;
  mutate: (sessionId: string, operation: () => Promise<TaskQueueSnapshot>) => Promise<TaskQueueSnapshot>;
}

function replaceSet(set: Set<string>, sessionId: string, present: boolean): Set<string> {
  const next = new Set(set);
  if (present) next.add(sessionId);
  else next.delete(sessionId);
  return next;
}

function errorMessage(error: unknown): string {
  return translateError(error);
}

export const useTaskQueueStore = create<TaskQueueState>((set, get) => ({
  snapshots: new Map(),
  loadingSessions: new Set(),
  mutatingSessions: new Set(),
  errors: new Map(),
  _initialized: false,
  _unlisten: null,

  initialize: async () => {
    if (get()._initialized) return;
    set({ _initialized: true });
    try {
      const unlisten = await taskQueueService.subscribe((snapshot) => {
        get().applySnapshot(snapshot);
      });
      set({ _unlisten: unlisten });
    } catch (error) {
      set({ _initialized: false });
      throw error;
    }
  },

  cleanup: () => {
    get()._unlisten?.();
    set({ _initialized: false, _unlisten: null });
  },

  dropSession: (sessionId) => {
    set((state) => {
      const snapshots = new Map(state.snapshots);
      snapshots.delete(sessionId);
      const errors = new Map(state.errors);
      errors.delete(sessionId);
      return {
        snapshots,
        loadingSessions: replaceSet(state.loadingSessions, sessionId, false),
        mutatingSessions: replaceSet(state.mutatingSessions, sessionId, false),
        errors,
      };
    });
  },

  load: async (sessionId) => {
    set((state) => {
      const errors = new Map(state.errors);
      errors.delete(sessionId);
      return {
        loadingSessions: replaceSet(state.loadingSessions, sessionId, true),
        errors,
      };
    });
    try {
      await get().initialize();
      // Keep this read independent of mutation responses. It repairs missed events after reload.
      const snapshot = await taskQueueService.get(sessionId);
      get().applySnapshot(snapshot);
      return snapshot;
    } catch (error) {
      const errors = new Map(get().errors);
      errors.set(sessionId, errorMessage(error));
      set({ errors });
      throw error;
    } finally {
      set((state) => ({ loadingSessions: replaceSet(state.loadingSessions, sessionId, false) }));
    }
  },

  applySnapshot: (snapshot) => {
    set((state) => {
      const current = state.snapshots.get(snapshot.sessionId);
      if (current && snapshot.revision < current.revision) return state;
      const snapshots = new Map(state.snapshots);
      snapshots.set(snapshot.sessionId, snapshot);
      const errors = new Map(state.errors);
      errors.delete(snapshot.sessionId);
      return { snapshots, errors };
    });
  },

  stageClipboardImage: (sessionId) => taskQueueService.stageClipboardImage(sessionId),

  addItem: async (sessionId, draft) => get().mutate(sessionId, () => taskQueueService.addItem(sessionId, draft)),
  deleteItem: async (sessionId, itemId) => get().mutate(sessionId, () => taskQueueService.deleteItem(sessionId, itemId)),
  clear: async (sessionId) => get().mutate(sessionId, () => taskQueueService.clear(sessionId)),
  update: async (sessionId, patch) => get().mutate(sessionId, () => taskQueueService.update(sessionId, patch)),
  retry: async (sessionId, itemId) => get().mutate(sessionId, () => taskQueueService.retry(sessionId, itemId)),

  // This internal action is kept on the store to make every mutation follow the same authoritative-response path.
  mutate: async (sessionId: string, operation: () => Promise<TaskQueueSnapshot>) => {
    set((state) => ({
      mutatingSessions: replaceSet(state.mutatingSessions, sessionId, true),
      errors: new Map(state.errors),
    }));
    try {
      const snapshot = await operation();
      get().applySnapshot(snapshot);
      return snapshot;
    } catch (error) {
      const errors = new Map(get().errors);
      errors.set(sessionId, errorMessage(error));
      set({ errors });
      throw error;
    } finally {
      set((state) => ({ mutatingSessions: replaceSet(state.mutatingSessions, sessionId, false) }));
    }
  },
}));

registerSessionScopedResource({
  name: "taskQueue",
  dispose: (sessionId) => useTaskQueueStore.getState().dropSession(sessionId),
});
