import type { TaskBinding, TaskBindingChangedEvent, TaskBindingNode, TaskBindingQuery } from "@/types";
import { parseWslUnc } from "@/utils/wslPath";
import type { OrchestratorState } from "./orchestratorState";
export const SELECTED_TASK_STORAGE_KEY = "cc-panes-orchestration-selected-task-id";
export function readSelectedTaskId(): string | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage.getItem(SELECTED_TASK_STORAGE_KEY); } catch { return null; }
}
export function syncSelectedTaskId(id: string | null): void {
  if (typeof window === "undefined") return;
  try { if (id) window.sessionStorage.setItem(SELECTED_TASK_STORAGE_KEY, id); else window.sessionStorage.removeItem(SELECTED_TASK_STORAGE_KEY); } catch { /* restricted webview */ }
}
const asciiLower = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
/** Mirrors the service's comparison key, including Windows /mnt and WSL UNC paths. */
export function normalizePlanPath(path: string): string {
  let value = path.trim().replace(/^\\\\\?\\(?=[A-Za-z]:)/, "").replace(/\\/g, "/");
  const wsl = parseWslUnc(path);
  if (wsl && /^\/mnt\/[A-Za-z]\//.test(wsl.posix)) value = wsl.posix;
  value = value.replace(/\/+/g, "/").replace(/\/+$/, "");
  const mounted = /^\/mnt\/([A-Za-z])\/(.+)$/.exec(value);
  if (mounted) return asciiLower(`${mounted[1]}:/${mounted[2]}`);
  return /^[A-Za-z]:\//.test(value) ? asciiLower(value) : value;
}
export function activeQuery(state: OrchestratorState): TaskBindingQuery {
  const query: TaskBindingQuery = {
    status: state.filterTab === "all" ? undefined : state.filterTab,
    workspaceName: state.filterWorkspace ?? undefined, projectPath: state.filterProjectPath ?? undefined,
    role: state.filterRole ?? undefined, search: state.searchKeyword.trim() || undefined, ...state.queryOverrides,
  };
  if (!query.normalizedPlanPath && query.planPath) query.normalizedPlanPath = normalizePlanPath(query.planPath);
  if (query.normalizedPlanPath) delete query.planPath;
  delete query.limit; delete query.offset;
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)) as TaskBindingQuery;
}
export function matchesQuery(binding: TaskBinding, query: TaskBindingQuery): boolean {
  for (const [key, value] of Object.entries(query)) {
    if (key === "search") continue;
    const actual = key === "role" && (binding.role as string) === "child" ? "worker" : binding[key as keyof TaskBinding];
    if (actual !== value) return false;
  }
  if (!query.search) return true;
  // SQLite LIKE: ASCII case folding, %/_ wildcards, each column independently.
  const expression = asciiLower(query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]");
  const pattern = new RegExp(expression, "u");
  return pattern.test(asciiLower(binding.title)) || pattern.test(asciiLower(binding.prompt ?? ""));
}
export function orderBindings(bindings: TaskBinding[]): TaskBinding[] {
  return bindings.sort((a, b) => a.sortOrder - b.sortOrder || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function keepWindow(state: OrchestratorState, bindings: TaskBinding[]): TaskBinding[] {
  const ordered = orderBindings(bindings);
  const size = Math.max(state.pageLimit, state.loadedWindowSize);
  const selected = ordered.find((item) => item.id === state.selectedTaskId);
  const result = ordered.slice(0, size);
  if (selected && !result.some((item) => item.id === selected.id)) result.push(selected);
  return orderBindings(result);
}
export function ensureSelectedTask(state: OrchestratorState): void {
  if (state.selectedTaskId && !state.bindings.some((item) => item.id === state.selectedTaskId)) {
    state.selectedTaskId = state.bindings[0]?.id ?? null; syncSelectedTaskId(state.selectedTaskId);
  }
}
function olderThan(next: TaskBinding, previous: TaskBinding): boolean {
  if (next.reportRevision !== undefined && previous.reportRevision !== undefined && next.reportRevision < previous.reportRevision) return true;
  const a = Date.parse(next.updatedAt); const b = Date.parse(previous.updatedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a !== b) return a < b;
  const fraction = (value: string) => (/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? "").padEnd(9, "0");
  return fraction(next.updatedAt) < fraction(previous.updatedAt);
}
/** One path for mutation replies and events. Per-ID versions make a later event
 * authoritative over any operation that was already in flight when it arrived. */
export function applyBindingChange(state: OrchestratorState, event: TaskBindingChangedEvent, startedAt?: number): boolean {
  if (startedAt !== undefined && (state.mutationVersions[event.id] ?? 0) > startedAt) return false;
  if (event.op !== "delete" && !event.binding) return false;
  const hadKnown = Object.prototype.hasOwnProperty.call(state.knownBindings, event.id);
  const old = hadKnown ? state.knownBindings[event.id] : state.bindings.find((item) => item.id === event.id);
  const next = event.op === "delete" ? null : event.binding!;
  if (next && old && olderThan(next, old)) return true;
  const query = activeQuery(state);
  const was = old ? matchesQuery(old, query) : false;
  const now = next ? matchesQuery(next, query) : false;
  const known = hadKnown || old !== undefined;
  const moreBefore = state.hasMore;
  state.mutationVersions[event.id] = ++state.mutationVersion;
  // An unseen queued event might already be included in the last query (or
  // obsolete). Wait for DB confirmation instead of inventing a new visible row.
  if (!known && startedAt === undefined && next) return true;
  state.knownBindings[event.id] = next;
  // Unknown updates may already be counted beyond this window. Requery instead
  // of inventing a membership delta; explicit creates have a known absent before.
  if (known || (event.op === "create" && startedAt !== undefined)) state.total = Math.max(0, state.total + Number(now) - Number(was));
  state.bindings = state.bindings.filter((item) => item.id !== event.id);
  if (next && now) state.bindings.push(next);
  state.bindings = keepWindow(state, state.bindings);
  state.total = Math.max(state.total, state.bindings.length);
  state.hasMore = state.baseOffset + state.loadedWindowSize < state.total;
  ensureSelectedTask(state);
  const moved = old && next && (old.sortOrder !== next.sortOrder || old.createdAt !== next.createdAt);
  return !known || Boolean(moreBefore && (was !== now || moved));
}
export function buildTaskTree(bindings: TaskBinding[]): TaskBindingNode[] {
  const nodes = new Map<string, TaskBindingNode>(bindings.map((binding) => [binding.id, { ...binding, children: [] as TaskBindingNode[], depth: 0 }]));
  const roots: TaskBindingNode[] = [];
  for (const node of nodes.values()) { const parent = node.parentId ? nodes.get(node.parentId) : null; if (parent) parent.children.push(node); else roots.push(node); }
  const assignDepth = (node: TaskBindingNode, depth: number) => { node.depth = depth; for (const child of node.children) assignDepth(child, depth + 1); };
  for (const root of roots) assignDepth(root, 0);
  return roots;
}
