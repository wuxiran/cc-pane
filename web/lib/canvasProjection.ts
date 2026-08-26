import { collectPanels, collectTerminalLeaves } from "@/lib/paneTree";
import type { PaneNode, Tab, TaskBinding, TerminalPaneLeaf } from "@/types";
import type { CanvasMediaEdgeProjection, CanvasNodeProjection, CanvasPipeEvent, CanvasProjectionInput, NodeVisualState, PipeEdge } from "@/types/canvas";

function bindingStatus(binding: TaskBinding): NodeVisualState {
  return binding.status;
}

function terminalState(leaf: TerminalPaneLeaf, sessionId?: string): NodeVisualState {
  if (leaf.disconnected || leaf.restoreBlockedReason) return "offline";
  if (sessionId) return "running";
  return "idle";
}

/** Canvas is an active-session view; history and failed records stay in orchestration. */
export function isCanvasVisibleBinding(binding: TaskBinding): boolean {
  return binding.status === "running";
}

function isCanvasVisibleTerminal(
  item: { leaf: TerminalPaneLeaf; sessionId?: string },
): boolean {
  return Boolean(item.sessionId) && !item.leaf.disconnected && !item.leaf.restoreBlockedReason && !item.leaf.restoring;
}

function terminalLeavesForLayout(rootPane: PaneNode): Array<{
  paneId: string;
  tab: Tab;
  leaf: TerminalPaneLeaf;
  sessionId?: string;
}> {
  return collectPanels(rootPane).flatMap((panel) => panel.tabs.flatMap((tab) => {
    if (tab.contentType !== "terminal" || !tab.terminalRootPane) return [];
    return collectTerminalLeaves(tab.terminalRootPane).map((leaf) => ({
      paneId: panel.id,
      tab,
      leaf,
      // Multi-terminal tabs historically stored the live session on the tab
      // before the leaf metadata was hydrated. Keep both identities usable.
      sessionId: leaf.sessionId ?? tab.sessionId ?? undefined,
    }));
  }));
}

function matchBindingLeaf(
  binding: TaskBinding,
  leaves: Array<{
    paneId: string;
    tab: Tab;
    leaf: TerminalPaneLeaf;
    sessionId?: string;
    layoutId: string;
  }>,
) {
  const bySession = binding.sessionId
    ? leaves.find((item) => item.sessionId === binding.sessionId)
    : undefined;
  if (bySession) return bySession;

  const byTab = binding.tabId
    ? leaves.find((item) => item.tab.id === binding.tabId)
    : undefined;
  if (byTab) return byTab;

  if (!binding.paneId) return undefined;
  const paneMatches = leaves.filter((item) => item.paneId === binding.paneId);
  return paneMatches.length === 1 ? paneMatches[0] : undefined;
}

interface BindingIdentity {
  paneId?: string;
  tabId?: string;
  parentTabId?: string;
  sessionId?: string;
  parentSessionId?: string;
  parentBindingId?: string;
  layoutId?: string;
  leafId?: string;
  projectPath?: string;
}

interface MetadataParentIds {
  bindingId?: string;
  sessionId?: string;
  tabId?: string;
}

/**
 * Merge media projections from the durable store and an optional live source.
 * The live source is applied last so a freshly reported run status wins, while
 * omitted fields (for example an already-resolved preview URL) stay intact.
 * Keeping this normalization in the projection layer prevents duplicate cards
 * regardless of which caller supplies the two sources.
 */
export function mergeCanvasMediaNodes(...sources: CanvasNodeProjection[][]): CanvasNodeProjection[] {
  const byId = new Map<string, CanvasNodeProjection>();
  for (const source of sources) {
    for (const node of source) {
      if (node.kind !== "media") continue;
      const previous = byId.get(node.id);
      if (!previous) {
        byId.set(node.id, node);
        continue;
      }
      byId.set(node.id, {
        ...previous,
        ...node,
        media: previous.media && node.media
          ? { ...previous.media, ...node.media, mediaKind: node.media.mediaKind ?? previous.media.mediaKind }
          : node.media ?? previous.media,
      });
    }
  }
  return [...byId.values()];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataParentIds(binding: TaskBinding): MetadataParentIds {
  const metadata = asRecord(binding.metadata);
  if (!metadata) return {};

  // dispatchEnvelope is the durable wire contract. Keep the direct and snake
  // case fallbacks for bindings written by older adapters.
  const envelope = asRecord(metadata.dispatchEnvelope)
    ?? asRecord(metadata.dispatch_envelope)
    ?? metadata;
  return {
    bindingId: nonEmptyString(envelope.parentBindingId)
      ?? nonEmptyString(envelope.parent_binding_id)
      ?? nonEmptyString(metadata.parentBindingId)
      ?? nonEmptyString(metadata.parent_binding_id),
    sessionId: nonEmptyString(envelope.parentSessionId)
      ?? nonEmptyString(envelope.parent_session_id)
      ?? nonEmptyString(metadata.parentSessionId)
      ?? nonEmptyString(metadata.parent_session_id),
    tabId: nonEmptyString(envelope.parentTabId)
      ?? nonEmptyString(envelope.parent_tab_id)
      ?? nonEmptyString(metadata.parentTabId)
      ?? nonEmptyString(metadata.parent_tab_id),
  };
}

/** Projects bindings first, then only unbound leaves, so task identity survives layout moves. */
export function projectCanvasNodes({ bindings, layouts, layoutId, mediaNodes = [] }: CanvasProjectionInput): CanvasNodeProjection[] {
  const allLeaves = layouts
    .filter((layout) => layout.kind !== "starred")
    .flatMap((layout) => terminalLeavesForLayout(layout.rootPane).map((item) => ({ ...item, layoutId: layout.id })));
  const leaves = layoutId
    ? allLeaves.filter((item) => item.layoutId === layoutId)
    : allLeaves;
  const byBinding = new Map<string, BindingIdentity>();
  for (const binding of bindings) {
    const match = matchBindingLeaf(binding, allLeaves);
    const metadataParents = metadataParentIds(binding);
    byBinding.set(binding.id, match ? {
      paneId: match.paneId,
      tabId: match.tab.id,
      parentTabId: match.tab.parentTabId ?? metadataParents.tabId,
      sessionId: match.sessionId ?? binding.sessionId,
      parentSessionId: metadataParents.sessionId,
      parentBindingId: nonEmptyString(binding.parentId) ?? metadataParents.bindingId,
      layoutId: match.layoutId,
      leafId: match.leaf.id,
      projectPath: match.tab.projectPath,
    } : {
      paneId: binding.paneId,
      tabId: binding.tabId,
      sessionId: binding.sessionId,
      parentSessionId: metadataParents.sessionId,
      parentBindingId: nonEmptyString(binding.parentId) ?? metadataParents.bindingId,
    });
  }

  // A dispatch can arrive before the child binding has its tab/session fields
  // reconciled. Copy the parent's live identity into the fallback fields so a
  // running child still gets a visible static edge as soon as both cards exist.
  for (const binding of bindings) {
    const identity = byBinding.get(binding.id);
    if (!identity) continue;
    const parentBindingId = identity.parentBindingId;
    const parentIdentity = parentBindingId ? byBinding.get(parentBindingId) : undefined;
    const parentBinding = parentBindingId
      ? bindings.find((candidate) => candidate.id === parentBindingId)
      : undefined;
    identity.parentTabId ??= parentIdentity?.tabId;
    identity.parentSessionId ??= parentIdentity?.sessionId
      ?? parentBinding?.sessionId;
  }

  const taskNodes = bindings.flatMap((binding) => {
    if (!isCanvasVisibleBinding(binding)) return [];
    const identity = byBinding.get(binding.id) ?? {};
    if (layoutId && identity.layoutId !== layoutId) return [];
    return [{
      id: `binding:${binding.id}`,
      label: binding.title,
      kind: "task" as const,
      bindingId: binding.id,
      parentId: identity.parentBindingId ? `binding:${identity.parentBindingId}` : undefined,
      paneId: identity.paneId,
      tabId: identity.tabId,
      parentTabId: identity.parentTabId,
      parentSessionId: identity.parentSessionId,
      sessionId: identity.sessionId,
      leafId: identity.leafId,
      layoutId: identity.layoutId,
      projectPath: identity.projectPath ?? binding.projectPath,
      workspaceName: binding.workspaceName,
      cliTool: binding.cliTool,
      role: binding.role,
      status: bindingStatus(binding),
      progress: binding.progress,
    }];
  });

  const represented = new Set<string>();
  const hiddenLeafIds = new Set<string>();
  const hiddenTabIds = new Set<string>();
  const hiddenSessionIds = new Set<string>();
  const visibleLeafIds = new Set<string>();
  const visibleTabIds = new Set<string>();
  const visibleSessionIds = new Set<string>();
  for (const binding of bindings) {
    const identity = byBinding.get(binding.id);
    if (identity?.leafId) represented.add(identity.leafId);
    if (!identity) continue;
    const targetSets = isCanvasVisibleBinding(binding)
      ? { leaf: visibleLeafIds, tab: visibleTabIds, session: visibleSessionIds }
      : { leaf: hiddenLeafIds, tab: hiddenTabIds, session: hiddenSessionIds };
    if (identity.leafId) targetSets.leaf.add(identity.leafId);
    if (identity.tabId) targetSets.tab.add(identity.tabId);
    if (identity.sessionId) targetSets.session.add(identity.sessionId);
  }
  const terminalNodes = leaves
    .filter((item) => {
      if (represented.has(item.leaf.id) || !isCanvasVisibleTerminal(item)) return false;
      // A failed/completed/pending binding can still leave a live PTY leaf in
      // the pane tree. Do not let that historical leaf re-enter Canvas as an
      // unbound terminal. A running binding wins if identities overlap.
      const blocked = hiddenLeafIds.has(item.leaf.id)
        || hiddenTabIds.has(item.tab.id)
        || Boolean(item.sessionId && hiddenSessionIds.has(item.sessionId));
      const visible = visibleLeafIds.has(item.leaf.id)
        || visibleTabIds.has(item.tab.id)
        || Boolean(item.sessionId && visibleSessionIds.has(item.sessionId));
      return !blocked || visible;
    })
    .map(({ paneId, tab, leaf, layoutId, sessionId }) => ({
      id: `leaf:${leaf.id}`,
      label: tab.title || "Terminal",
      kind: "terminal" as const,
      paneId,
      tabId: tab.id,
      parentTabId: tab.parentTabId,
      parentSessionId: undefined,
      sessionId,
      leafId: leaf.id,
      layoutId,
      projectPath: tab.projectPath,
      cliTool: tab.cliTool,
      status: terminalState(leaf, sessionId),
    }));
  // Media nodes are persisted independently from terminal bindings. Keep them
  // as a separate projection branch so the existing task/terminal visibility
  // rules remain unchanged and a partially hydrated media runtime cannot make
  // a terminal leaf reappear.
  const visibleMediaNodes = mergeCanvasMediaNodes(mediaNodes).filter((node) => !layoutId || node.layoutId === layoutId);
  return [...taskNodes, ...terminalNodes, ...visibleMediaNodes];
}

/** Resolve session-only events to binding node ids before rendering layers consume them. */
export function resolveCanvasEventNodes(
  events: CanvasPipeEvent[],
  nodes: CanvasNodeProjection[],
): CanvasPipeEvent[] {
  const byBinding = new Map(nodes.filter((node) => node.bindingId).map((node) => [node.bindingId as string, node.id]));
  const bySession = new Map(nodes.filter((node) => node.sessionId).map((node) => [node.sessionId as string, node.id]));
  const resolveExplicit = (id: string | undefined): string | undefined => {
    if (id?.startsWith("binding:")) return byBinding.get(id.slice("binding:".length));
    if (id?.startsWith("session:")) return bySession.get(id.slice("session:".length));
    return id && (byBinding.get(id) ?? bySession.get(id));
  };
  const resolve = (id: string | undefined, bindingId: string | undefined, sessionId: string | undefined): string | undefined => {
    return resolveExplicit(id)
      || (bindingId && byBinding.get(bindingId))
      || (sessionId && bySession.get(sessionId))
      || (sessionId ? `session:${sessionId}` : id);
  };
  return events.map((event) => ({
    ...event,
    sourceId: resolve(event.sourceId, event.fromBinding, event.fromSession),
    targetId: resolve(event.targetId, event.toBinding, event.toSession),
  }));
}

export function deriveParentEdges(nodes: CanvasNodeProjection[]): PipeEdge[] {
  const ids = new Set(nodes.map((node) => node.id));
  const byTabId = new Map(nodes.flatMap((node) => node.tabId ? [[node.tabId, node.id] as const] : []));
  const bySessionId = new Map(nodes.flatMap((node) => node.sessionId ? [[node.sessionId, node.id] as const] : []));
  const leaders = nodes.filter((node) => node.role === "leader");
  return nodes.flatMap((node) => {
    const parentId = (node.parentId && ids.has(node.parentId)
      ? node.parentId
      : (node.parentTabId ? byTabId.get(node.parentTabId) : undefined)
        ?? (node.parentSessionId ? bySessionId.get(node.parentSessionId) : undefined)
        ?? (node.role === "worker" && leaders.length === 1 && leaders[0].id !== node.id
          ? leaders[0].id
          : undefined));
    return parentId && parentId !== node.id
      ? [{ id: `pipe:${parentId}->${node.id}`, sourceId: parentId, targetId: node.id, readOnly: true as const }]
      : [];
  });
}

function eventEndpointId(event: CanvasPipeEvent, side: "source" | "target"): string | undefined {
  if (side === "source") {
    return event.sourceId
      ?? (event.fromBinding ? `binding:${event.fromBinding}` : undefined)
      ?? (event.fromSession ? `session:${event.fromSession}` : undefined);
  }
  return event.targetId
    ?? (event.toBinding ? `binding:${event.toBinding}` : undefined)
    ?? (event.toSession ? `session:${event.toSession}` : undefined);
}

function resolveEventNodeId(
  id: string,
  nodeIds: Set<string>,
  byBinding: Map<string, string>,
  bySession: Map<string, string>,
): string {
  if (nodeIds.has(id)) return id;
  if (id.startsWith("binding:")) return byBinding.get(id.slice("binding:".length)) ?? id;
  if (id.startsWith("session:")) return bySession.get(id.slice("session:".length)) ?? id;
  return byBinding.get(id) ?? bySession.get(id) ?? id;
}

function undirectedEdgeKey(sourceId: string, targetId: string): string {
  return [sourceId, targetId].sort().join("\u0000");
}

/**
 * Derives the visible graph from durable parent links and real transport
 * events. Event edges fill the gap for sessions that were launched together
 * before their TaskBinding parent relationship was persisted.
 */
export function derivePipeEdges(
  nodes: CanvasNodeProjection[],
  events: CanvasPipeEvent[] = [],
  mediaEdges: CanvasMediaEdgeProjection[] = [],
): PipeEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const byBinding = new Map(nodes.flatMap((node) => node.bindingId ? [[node.bindingId, node.id] as const] : []));
  const bySession = new Map(nodes.flatMap((node) => node.sessionId ? [[node.sessionId, node.id] as const] : []));
  const edges = deriveParentEdges(nodes);
  const pairs = new Set(edges.map((edge) => undirectedEdgeKey(edge.sourceId, edge.targetId)));

  for (const event of events) {
    const sourceEndpoint = eventEndpointId(event, "source");
    const targetEndpoint = eventEndpointId(event, "target");
    const sourceId = sourceEndpoint ? resolveEventNodeId(sourceEndpoint, nodeIds, byBinding, bySession) : undefined;
    const targetId = targetEndpoint ? resolveEventNodeId(targetEndpoint, nodeIds, byBinding, bySession) : undefined;
    if (!sourceId || !targetId || sourceId === targetId) continue;
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) continue;
    const pair = undirectedEdgeKey(sourceId, targetId);
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    edges.push({
      id: `pipe:event:${sourceId}->${targetId}`,
      sourceId,
      targetId,
      readOnly: true,
    });
  }

  // Media edges are persisted independently from orchestration events. They
  // are intentionally read-only in this graph layer; creation/deletion stays
  // behind the MediaService validation boundary.
  for (const mediaEdge of mediaEdges) {
    const sourceId = mediaEdge.sourceNodeId.startsWith("media:")
      ? mediaEdge.sourceNodeId
      : `media:${mediaEdge.sourceNodeId}`;
    const targetId = mediaEdge.targetNodeId.startsWith("media:")
      ? mediaEdge.targetNodeId
      : `media:${mediaEdge.targetNodeId}`;
    if (sourceId === targetId || !nodeIds.has(sourceId) || !nodeIds.has(targetId)) continue;
    const pair = undirectedEdgeKey(sourceId, targetId);
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    edges.push({
      id: `media-edge:${mediaEdge.id}`,
      sourceId,
      targetId,
      readOnly: true,
    });
  }

  return edges;
}
