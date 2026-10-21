import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrchestratorStore } from "./useOrchestratorStore";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { TaskBinding, TaskBindingQuery, TaskBindingQueryResult } from "@/types";
function binding(id: string, patch: Partial<TaskBinding> = {}): TaskBinding {
  return { id, title: id, role: "task", projectPath: "/repo", cliTool: "claude", status: "running", progress: 0,
    sortOrder: Number(id.replace(/\D/g, "")) || 0, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", ...patch };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const page = (items: TaskBinding[]): TaskBindingQueryResult => ({ items, total: items.length, hasMore: false });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function server(rows: () => TaskBinding[], calls: TaskBindingQuery[]) {
  return (_command: string, args?: Record<string, unknown>) => {
    const query = (args?.query ?? {}) as TaskBindingQuery; calls.push(query);
    const matching = rows().filter((row) => (!query.status || row.status === query.status) && (!query.workspaceName || row.workspaceName === query.workspaceName));
    const start = query.offset ?? 0; const size = Math.min(query.limit ?? 50, 200);
    return { items: matching.slice(start, start + size), total: matching.length, hasMore: start + size < matching.length };
  };
}
beforeEach(() => {
  resetTauriInvoke(); window.sessionStorage.clear();
  useOrchestratorStore.setState(useOrchestratorStore.getInitialState(), true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
describe("orchestrator window and mutation consistency", () => {
  it("preserves 300 loaded rows and a late-page selection after polling with a 200-row server cap", async () => {
    const rows = Array.from({ length: 350 }, (_, index) => binding(`task-${index + 1}`)); const calls: TaskBindingQuery[] = [];
    mockTauriInvoke({ query_task_bindings: server(() => rows, calls), get_task_binding: (_cmd: string, args?: Record<string, unknown>) => rows.find((item) => item.id === args?.id) ?? null });
    const store = useOrchestratorStore.getState();
    await store.loadBindings({ limit: 100 }); await store.loadMoreBindings(); await store.loadMoreBindings();
    expect(useOrchestratorStore.getState().bindings).toHaveLength(300);
    store.setSelectedTaskId("task-250"); await store.loadBindings();
    const state = useOrchestratorStore.getState();
    expect(state.bindings).toHaveLength(300); expect(state.selectedTaskId).toBe("task-250");
    expect(state.pageLimit).toBe(100); expect(state.hasMore).toBe(true);
    expect(calls.every((query) => (query.limit ?? 50) <= 200)).toBe(true);
  });

  it("rebuilds the loaded prefix before expanding, so an intervening delete and reorder do not skip rows", async () => {
    let rows = Array.from({ length: 240 }, (_, index) => binding(`task-${index + 1}`)); const calls: TaskBindingQuery[] = [];
    mockTauriInvoke({ query_task_bindings: server(() => rows, calls) });
    const store = useOrchestratorStore.getState(); await store.loadBindings({ limit: 100 });
    rows = rows.filter((item) => item.id !== "task-5");
    const moved = { ...rows.find((item) => item.id === "task-220")!, sortOrder: -1 };
    rows = [moved, ...rows.filter((item) => item.id !== moved.id)];
    await store.loadMoreBindings();
    expect(useOrchestratorStore.getState().bindings.map((item) => item.id)).toEqual(rows.slice(0, 200).map((item) => item.id));
  });

  it("applies a kill event and its patch response only once under the running filter", async () => {
    const original = binding("task-1"); const completed = { ...original, status: "completed" as const, updatedAt: "2026-10-21T00:01:00Z" };
    const patch = deferred<TaskBinding>();
    useOrchestratorStore.setState({ bindings: [original], total: 1, filterTab: "running", selectedTaskId: original.id });
    mockTauriInvoke({ update_task_binding_patch: () => patch.promise });
    const action = useOrchestratorStore.getState().updatePatch(original.id, { status: "completed" });
    useOrchestratorStore.getState().applyChangedEvent({ op: "update", id: original.id, binding: completed });
    patch.resolve(completed); await action;
    const state = useOrchestratorStore.getState();
    expect(state.bindings).toEqual([]); expect(state.total).toBe(0); expect(state.selectedTaskId).toBeNull();
  });

  it("does not resurrect a deleted task when an older session patch returns", async () => {
    const original = binding("task-1", { sessionId: "session-1" }); const patch = deferred<TaskBinding>();
    useOrchestratorStore.setState({ bindings: [original], total: 1 });
    mockTauriInvoke({ find_task_binding_by_session: original, update_task_binding_patch: () => patch.promise });
    const action = useOrchestratorStore.getState().updateBySessionId("session-1", { progress: 50 });
    await flush(); useOrchestratorStore.getState().applyChangedEvent({ op: "delete", id: original.id });
    patch.resolve({ ...original, progress: 50 }); await action;
    expect(useOrchestratorStore.getState().bindings).toEqual([]); expect(useOrchestratorStore.getState().total).toBe(0);
  });

  it("keeps filter B when both a query and an action started under A return late", async () => {
    const a = binding("task-1", { workspaceName: "A" }); const b = binding("task-2", { workspaceName: "B" });
    const oldQuery = deferred<TaskBindingQueryResult>(); const oldPatch = deferred<TaskBinding>();
    mockTauriInvoke({ query_task_bindings: (_cmd: string, args?: Record<string, unknown>) => (args?.query as TaskBindingQuery).workspaceName === "A" ? oldQuery.promise : page([b]), update_task_binding_patch: () => oldPatch.promise });
    const store = useOrchestratorStore.getState(); store.setFilterWorkspace("A");
    const action = store.updatePatch(a.id, { progress: 50 }); store.setFilterWorkspace("B"); await flush();
    oldQuery.resolve(page([a])); oldPatch.resolve({ ...a, progress: 50 }); await action; await flush();
    expect(useOrchestratorStore.getState().bindings).toEqual([b]); expect(useOrchestratorStore.getState().total).toBe(1);
  });

  it("does not let an in-flight stale query undo a newer event", async () => {
    const original = binding("task-1"); const oldQuery = deferred<TaskBindingQueryResult>(); let queries = 0;
    useOrchestratorStore.setState({ bindings: [original], total: 1, filterTab: "running" });
    mockTauriInvoke({ query_task_bindings: () => ++queries === 1 ? oldQuery.promise : page([]) });
    const action = useOrchestratorStore.getState().loadBindings();
    useOrchestratorStore.getState().applyChangedEvent({ op: "update", id: original.id, binding: { ...original, status: "completed" } });
    oldQuery.resolve(page([original])); await action;
    expect(useOrchestratorStore.getState().bindings).toEqual([]); expect(useOrchestratorStore.getState().total).toBe(0);
  });

  it("deduplicates delete responses and reconciles unknown creates against authoritative totals", async () => {
    let rows = Array.from({ length: 100 }, (_, index) => binding(`task-${index + 1}`));
    const calls: TaskBindingQuery[] = []; const removal = deferred<boolean>();
    mockTauriInvoke({ query_task_bindings: server(() => rows, calls), delete_task_binding: () => removal.promise });
    const store = useOrchestratorStore.getState(); await store.loadBindings();
    const action = store.remove("task-1"); rows = rows.filter((item) => item.id !== "task-1");
    store.applyChangedEvent({ op: "delete", id: "task-1" }); removal.resolve(true); await action;
    expect(useOrchestratorStore.getState().total).toBe(99);
    const added = binding("task-101"); rows.push(added);
    store.applyChangedEvent({ op: "create", id: added.id, binding: added }); await flush();
    store.applyChangedEvent({ op: "create", id: added.id, binding: added }); await flush();
    expect(useOrchestratorStore.getState().total).toBe(100);
  });
  it("restarts the whole prefix on revision changes even without frontend events", async () => {
    let rows = Array.from({ length: 320 }, (_, index) => binding(`task-${index + 1}`));
    const calls: TaskBindingQuery[] = []; let revision = "1"; let mutate = false;
    const query = server(() => rows, calls);
    mockTauriInvoke({ query_task_bindings: (command: string, args?: Record<string, unknown>) => {
      if (mutate && (args?.query as TaskBindingQuery).offset === 100) {
        mutate = false; revision = "2";
        rows = [binding("new-0", { sortOrder: -1 }), ...rows.filter((item) => item.id !== "task-5")];
      }
      return { ...query(command, args), revision };
    } });
    const store = useOrchestratorStore.getState(); await store.loadBindings({ limit: 100 });
    mutate = true; await store.loadMoreBindings();
    expect(useOrchestratorStore.getState().bindings.map((item) => item.id)).toEqual(rows.slice(0, 200).map((item) => item.id));
    expect(calls.filter((query) => query.offset === 0)).toHaveLength(3);
  });

  it("bounds retries during continuous changes, preserves data, and retries the failed expansion", async () => {
    const rows = Array.from({ length: 350 }, (_, index) => binding(`task-${index + 1}`)); const calls: TaskBindingQuery[] = [];
    let revision = 1; let unstable = false; const query = server(() => rows, calls);
    mockTauriInvoke({ query_task_bindings: (command: string, args?: Record<string, unknown>) => ({ ...query(command, args), revision: String(unstable ? ++revision : revision) }) });
    const store = useOrchestratorStore.getState(); await store.loadBindings({ limit: 100 }); store.setSelectedTaskId("task-80");
    unstable = true; await store.loadMoreBindings();
    expect(calls).toHaveLength(7); expect(useOrchestratorStore.getState().bindings).toHaveLength(100);
    expect(useOrchestratorStore.getState().selectedTaskId).toBe("task-80");
    expect(useOrchestratorStore.getState().loadError).toContain("changed");
    unstable = false; await store.retryBindings();
    expect(useOrchestratorStore.getState().bindings).toHaveLength(200);
    expect(useOrchestratorStore.getState().loadedWindowSize).toBe(200); expect(useOrchestratorStore.getState().loadError).toBeNull();
  });

  it("retries the backend snapshot-change marker but keeps ordinary failures retryable", async () => {
    let count = 0; const row = binding("task-1");
    mockTauriInvoke({ query_task_bindings: () => { if (++count === 1) throw "[TASK_QUERY_SNAPSHOT_CHANGED] concurrent writer"; return { ...page([row]), revision: "stable" }; } });
    await useOrchestratorStore.getState().loadBindings();
    expect(count).toBe(2); expect(useOrchestratorStore.getState().bindings).toEqual([row]);
    mockTauriInvoke({ query_task_bindings: () => { throw new Error("permission denied"); } });
    await useOrchestratorStore.getState().loadBindings();
    expect(useOrchestratorStore.getState().bindings).toEqual([row]); expect(useOrchestratorStore.getState().loadError).toBe("permission denied");
  });

  it("retains a selection shifted beyond the prefix without using its extra row as a paging offset", async () => {
    let rows = Array.from({ length: 350 }, (_, index) => binding(`task-${index + 1}`)); const calls: TaskBindingQuery[] = [];
    const query = server(() => rows, calls);
    mockTauriInvoke({ query_task_bindings: (command: string, args?: Record<string, unknown>) => ({ ...query(command, args), revision: "stable" }), get_task_binding: (_command: string, args?: Record<string, unknown>) => rows.find((item) => item.id === args?.id) ?? null });
    const store = useOrchestratorStore.getState(); await store.loadBindings({ limit: 100 }); store.setSelectedTaskId("task-90");
    rows = [...Array.from({ length: 200 }, (_, index) => binding(`new-${index}`, { sortOrder: index - 200 })), ...rows];
    await store.loadBindings(); expect(useOrchestratorStore.getState().bindings).toHaveLength(101);
    expect(useOrchestratorStore.getState().selectedTaskId).toBe("task-90");
    await store.loadMoreBindings(); expect(useOrchestratorStore.getState().bindings).toHaveLength(201);
    expect(useOrchestratorStore.getState().loadedWindowSize).toBe(200);
    expect(calls.some((query) => query.offset === 101)).toBe(false);
    await store.loadMoreBindings(); expect(useOrchestratorStore.getState().bindings).toHaveLength(300);
    expect(useOrchestratorStore.getState().bindings.filter((item) => item.id === "task-90")).toHaveLength(1);
  });

  it("does not overwrite a query's newer row with an earlier patch response when no event arrived", async () => {
    const original = binding("task-1"); let db = original; const patch = deferred<TaskBinding>();
    mockTauriInvoke({ query_task_bindings: () => page([db]), update_task_binding_patch: () => patch.promise });
    const store = useOrchestratorStore.getState(); await store.loadBindings();
    const action = store.updatePatch(original.id, { progress: 10 }); db = { ...original, progress: 90 };
    await store.loadBindings(); patch.resolve({ ...original, progress: 10 }); await action;
    expect(useOrchestratorStore.getState().bindings[0].progress).toBe(90);
  });

  it("reconciles overlapping writes in actual DB order instead of permanently discarding the last response", async () => {
    const original = binding("task-1"); let db = original; const first = deferred<TaskBinding>(); const second = deferred<TaskBinding>();
    let operations = 0;
    mockTauriInvoke({ query_task_bindings: () => page([db]), update_task_binding_patch: () => ++operations === 1 ? first.promise : second.promise });
    const store = useOrchestratorStore.getState(); await store.loadBindings();
    const a = store.updatePatch(original.id, { progress: 10 }); const b = store.updatePatch(original.id, { progress: 20 });
    db = { ...original, progress: 20 }; second.resolve(db); await b;
    expect(useOrchestratorStore.getState().bindings[0].progress).toBe(20);
    db = { ...original, progress: 10 }; first.resolve(db); await a;
    expect(useOrchestratorStore.getState().bindings[0].progress).toBe(10);
  });

  it("does not double count a repeated unseen create after requery fails with a full window", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => binding(`task-${index + 1}`));
    mockTauriInvoke({ query_task_bindings: () => page(rows) });
    const store = useOrchestratorStore.getState(); await store.loadBindings({ limit: 100 });
    mockTauriInvoke({ query_task_bindings: () => { throw new Error("offline"); } });
    const outside = binding("task-999");
    store.applyChangedEvent({ op: "create", id: outside.id, binding: outside }); await flush();
    store.applyChangedEvent({ op: "create", id: outside.id, binding: outside }); await flush();
    const state = useOrchestratorStore.getState();
    expect(state.total).toBe(100); expect(state.bindings).toHaveLength(100); expect(state.loadError).toBe("offline");
    expect(Object.keys(state.knownBindings)).toHaveLength(100);
    expect(Object.keys(state.mutationVersions).length).toBeLessThanOrEqual(100);
  });

  it("releases old cached rows after filter changes but keeps a deletion barrier needed by an in-flight action", async () => {
    const a = binding("task-1", { workspaceName: "A" }); const b = binding("task-2", { workspaceName: "B" });
    const patch = deferred<TaskBinding>();
    mockTauriInvoke({ query_task_bindings: (_cmd: string, args?: Record<string, unknown>) => page((args?.query as TaskBindingQuery).workspaceName === "A" ? [a] : [b]), update_task_binding_patch: () => patch.promise });
    const store = useOrchestratorStore.getState(); store.setFilterWorkspace("A"); await flush();
    const action = store.updatePatch(a.id, { progress: 10 }); store.setFilterWorkspace("B"); await flush();
    store.applyChangedEvent({ op: "delete", id: a.id });
    expect(useOrchestratorStore.getState().mutationVersions[a.id]).toBeGreaterThan(0);
    patch.resolve({ ...a, progress: 10 }); await action;
    expect(useOrchestratorStore.getState().bindings).toEqual([b]);
    expect(Object.keys(useOrchestratorStore.getState().knownBindings)).toEqual([b.id]);
    expect(useOrchestratorStore.getState().mutationVersions[a.id]).toBeUndefined();
  });

  it("does not downgrade a fresh query row when a previously queued older event arrives", async () => {
    const fresh = binding("task-1", { status: "completed", progress: 100, reportRevision: 2, updatedAt: "2026-10-21T00:00:00.123456789Z" });
    mockTauriInvoke({ query_task_bindings: () => page([fresh]) });
    const store = useOrchestratorStore.getState(); await store.loadBindings();
    store.applyChangedEvent({ op: "update", id: fresh.id, binding: { ...fresh, status: "running", progress: 10, reportRevision: 1, updatedAt: "2026-10-21T00:00:00.123456780Z" } });
    expect(useOrchestratorStore.getState().bindings[0].status).toBe("completed");
    await flush(); expect(useOrchestratorStore.getState().bindings).toEqual([fresh]);
  });

});
