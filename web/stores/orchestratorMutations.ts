import { taskBindingService } from "@/services";
import type { TaskBinding, TaskBindingChangedEvent } from "@/types";
import { applyBindingChange } from "./orchestratorProjection";
import type { OrchestratorCache } from "./orchestratorCache";
import type { OrchestratorGet, OrchestratorSet, OrchestratorState } from "./orchestratorState";

export function createMutationActions(set: OrchestratorSet, get: OrchestratorGet, cache: OrchestratorCache): Pick<OrchestratorState,
  "create" | "update" | "updatePatch" | "remove" | "removeCascade" | "applyChangedEvent" | "updateBySessionId"> {
  const perform = async <T>(operation: () => Promise<T>, events: (result: T) => TaskBindingChangedEvent[], ids?: string[]) => {
    const ticket = cache.begin(get(), ids);
    try {
      const result = await operation(); const changes = events(result); const unknownId = ticket.ids === null;
      if (!ticket.ids) cache.identify(ticket, changes.map((event) => event.id));
      let reconcile = false;
      set((state) => {
        for (const event of changes) {
          if (ticket.conflicted || (unknownId && ticket.start !== state.mutationVersion) || ticket.query !== state.queryCommitVersion || (state.mutationVersions[event.id] ?? 0) > ticket.start) {
            // A query/event/overlapping write won the race. Do not guess which
            // response is current: invalidate pending reads, then reconcile DB.
            state.mutationVersions[event.id] = ++state.mutationVersion; reconcile = true;
          } else reconcile = applyBindingChange(state, event, ticket.start) || reconcile;
        }
      });
      if (reconcile) await get().loadBindings();
      return result;
    } finally { set((state) => cache.finish(ticket, state)); }
  };
  const changed = (binding: TaskBinding): TaskBindingChangedEvent[] => [{ op: "update", id: binding.id, binding }];
  return {
    create: (request) => perform(() => taskBindingService.create(request), (binding) => [{ op: "create", id: binding.id, binding }]),
    update: (id, request) => perform(() => taskBindingService.update(id, request), changed, [id]),
    updatePatch: (id, patch) => perform(() => taskBindingService.updatePatch(id, patch), changed, [id]),
    remove: async (id) => { await perform(() => taskBindingService.delete(id), () => [{ op: "delete", id }], [id]); },
    removeCascade: async (id) => {
      const before = get(); const ids = new Set([id]);
      const known = [...before.bindings, ...Object.values(before.knownBindings).filter((value) => value !== null)];
      let changed = true;
      while (changed) {
        changed = false;
        for (const binding of known) if (binding.parentId && ids.has(binding.parentId) && !ids.has(binding.id)) { ids.add(binding.id); changed = true; }
      }
      await perform(() => taskBindingService.deleteCascade(id), () => [...ids].map((deleted) => ({ op: "delete", id: deleted })), [...ids]);
    },
    applyChangedEvent: (event) => {
      let reconcile = false;
      set((state) => { reconcile = applyBindingChange(state, event); });
      if (reconcile && !get().loading) void get().loadBindings();
      set((state) => cache.prune(state));
    },
    updateBySessionId: async (sessionId, updates) => {
      await perform(async () => {
        const binding = await taskBindingService.findBySession(sessionId);
        return binding ? taskBindingService.updatePatch(binding.id, updates) : null;
      }, (binding) => binding ? changed(binding) : []);
    },
  };
}
