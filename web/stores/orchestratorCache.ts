import type { OrchestratorState } from "./orchestratorState";
interface Ticket { start: number; query: number; ids: Set<string> | null; conflicted: boolean; }
/** Retain only visible records plus versions needed to reject outstanding writes.
 * Unknown-ID operations use the global mutation epoch instead of retaining an
 * unbounded set of unrelated event IDs while awaiting their response. */
export function createOrchestratorCache() {
  const active = new Set<Ticket>();
  const identify = (ticket: Ticket, ids: string[]) => {
    ticket.ids = new Set(ids);
    for (const other of active) if (other !== ticket && other.ids && ids.some((id) => other.ids!.has(id))) {
      ticket.conflicted = true; other.conflicted = true;
    }
  };
  const prune = (state: OrchestratorState) => {
    const visible = new Set(state.bindings.map((binding) => binding.id));
    const needed = (id: string) => visible.has(id) || [...active].some((ticket) => ticket.ids?.has(id) ?? false);
    for (const id of Object.keys(state.knownBindings)) if (!needed(id)) delete state.knownBindings[id];
    for (const id of Object.keys(state.mutationVersions)) if (!needed(id)) delete state.mutationVersions[id];
  };
  return {
    begin(state: OrchestratorState, ids?: string[]) {
      const ticket: Ticket = { start: state.mutationVersion, query: state.queryCommitVersion, ids: null, conflicted: false };
      active.add(ticket); if (ids) identify(ticket, ids); return ticket;
    },
    identify, prune,
    finish(ticket: Ticket, state: OrchestratorState) { active.delete(ticket); prune(state); },
  };
}
export type OrchestratorCache = ReturnType<typeof createOrchestratorCache>;
