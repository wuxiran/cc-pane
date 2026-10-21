import { taskBindingService } from "@/services";
import type { TaskBinding, TaskBindingQuery, TaskBindingQueryResult } from "@/types";
import { activeQuery, ensureSelectedTask, keepWindow, matchesQuery } from "./orchestratorProjection";
import type { OrchestratorCache } from "./orchestratorCache";
import type { OrchestratorGet, OrchestratorSet, OrchestratorState } from "./orchestratorState";

const MAX_ATTEMPTS = 3;
const errorText = (error: unknown): string => error instanceof Error ? error.message : error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
class ChangedWindow extends Error {}
class SupersededWindow extends Error {}
const keyOf = (query: TaskBindingQuery, offset: number) => JSON.stringify([Object.entries(query).sort(([a], [b]) => a.localeCompare(b)), offset]);
const pageSize = (value: number) => Number.isFinite(value) ? Math.max(1, Math.min(200, Math.floor(value))) : 50;
interface WindowResult { items: TaskBinding[]; total: number; hasMore: boolean; revision?: string; }

async function readWindow(query: TaskBindingQuery, offset: number, size: number, target: number, check: () => void): Promise<WindowResult> {
  const items: TaskBinding[] = []; const ids = new Set<string>();
  let first: TaskBindingQueryResult | null = null;
  let more = false; let read = 0;
  do {
    const limit = Math.min(size, target - read);
    const page = await taskBindingService.query({ ...query, offset: offset + read, limit });
    check();
    if (first && (page.revision !== first.revision || page.total !== first.total)) throw new ChangedWindow();
    if (page.items.length > limit || (!page.items.length && page.hasMore)) throw new Error("Invalid task pagination response");
    first ??= page;
    for (const binding of page.items) {
      if (ids.has(binding.id)) throw new ChangedWindow();
      ids.add(binding.id); items.push(binding);
    }
    more = page.hasMore; read += limit;
  } while (more && read < target);
  return { items, total: first?.total ?? 0, hasMore: more, revision: first?.revision };
}

async function retainSelection(result: WindowResult, query: TaskBindingQuery, offset: number, get: OrchestratorGet, check: () => void): Promise<void> {
  // A selected row may have moved beyond the loaded prefix. Keep it visible only
  // after checking that it still exists and belongs to this query.
  if (!result.hasMore) return;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const id = get().selectedTaskId;
    if (!id || result.items.some((item) => item.id === id)) return;
    const selected = await taskBindingService.get(id);
    check();
    const verify = await taskBindingService.query({ ...query, offset, limit: 1 });
    check();
    if (verify.revision !== result.revision || verify.total !== result.total) throw new ChangedWindow();
    if (get().selectedTaskId !== id) continue;
    if (selected && matchesQuery(selected, query)) result.items.push(selected);
    return;
  }
  throw new ChangedWindow();
}

function configure(state: OrchestratorState, query?: TaskBindingQuery): void {
  const before = keyOf(activeQuery(state), state.baseOffset);
  if (query?.limit !== undefined) state.pageLimit = pageSize(query.limit);
  const { limit: _limit, offset, ...criteria } = query ?? {};
  if (Object.values(criteria).some((value) => value !== undefined)) state.queryOverrides = criteria;
  if (offset !== undefined) state.baseOffset = Math.max(0, Math.floor(offset));
  if (before !== keyOf(activeQuery(state), state.baseOffset)) {
    state.filterGeneration++; state.loadedWindowSize = state.pageLimit;
    state.failedWindowSize = null; state.loadError = null;
    state.bindings = state.bindings.filter((item) => matchesQuery(item, activeQuery(state)));
    state.total = state.bindings.length; state.hasMore = false;
    ensureSelectedTask(state);
  }
}

export function createLoadingActions(set: OrchestratorSet, get: OrchestratorGet, cache: OrchestratorCache): Pick<OrchestratorState, "loadBindings" | "loadMoreBindings" | "retryBindings"> {
  let sequence = 0;
  let active: { request: number; key: string; target: number; promise: Promise<void> } | null = null;
  const load = (target: number): Promise<void> => {
    const initial = get(); const query = activeQuery(initial); const offset = initial.baseOffset;
    const key = keyOf(query, offset); const generation = initial.filterGeneration;
    if (active && initial.loading && active.request === initial.requestGeneration && active.key === key && active.target >= target) return active.promise;
    const request = ++sequence;
    set((state) => { state.requestGeneration = request; state.loading = true; });
    const valid = () => get().requestGeneration === request && get().filterGeneration === generation && keyOf(activeQuery(get()), get().baseOffset) === key;
    const run = async () => {
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          const epoch = get().mutationVersion;
          const check = () => { if (!valid()) throw new SupersededWindow(); if (get().mutationVersion !== epoch) throw new ChangedWindow(); };
          try {
            check();
            const result = await readWindow(query, offset, pageSize(get().pageLimit), target, check);
            await retainSelection(result, query, offset, get, check); check();
            set((state) => {
              state.loadedWindowSize = target;
              state.bindings = keepWindow(state, result.items.filter((item) => matchesQuery(item, query)));
              for (const binding of result.items) state.knownBindings[binding.id] = binding;
              state.total = result.total; state.hasMore = result.hasMore;
              state.loading = false; state.loadError = null; state.failedWindowSize = null; state.queryCommitVersion++;
              ensureSelectedTask(state); cache.prune(state);
            });
            return;
          } catch (error) { if (!(error instanceof ChangedWindow) && !errorText(error).startsWith("[TASK_QUERY_SNAPSHOT_CHANGED]")) throw error; }
        }
        throw new Error("Task list changed while loading. Retry to read a consistent list.");
      } catch (error) {
        if (!valid() || error instanceof SupersededWindow) return;
        console.error("[orchestrator] Failed to load bindings:", error);
        set((state) => { state.loading = false; state.failedWindowSize = target; state.loadError = errorText(error); cache.prune(state); });
      } finally { if (active?.request === request) active = null; }
    };
    const promise = run(); active = { request, key, target, promise }; return promise;
  };
  return {
    loadBindings: (query) => {
      set((state) => configure(state, query));
      return load(Math.max(get().pageLimit, get().loadedWindowSize, get().failedWindowSize ?? 0));
    },
    loadMoreBindings: () => {
      const state = get();
      if (state.loading || !state.hasMore) return Promise.resolve();
      return load(Math.max(state.loadedWindowSize, state.pageLimit) + state.pageLimit);
    },
    retryBindings: () => load(get().failedWindowSize ?? Math.max(get().loadedWindowSize, get().pageLimit)),
  };
}
