import { create } from "zustand";
import { mediaService } from "@/services/mediaService";
import { isMediaMimeCompatible, isMediaPreviewUrl, mediaNodeSubtype, toCanvasMediaNode, type MediaEdge, type MediaNode, type MediaRun } from "@/types/media";
import type { CanvasNodeProjection } from "@/types/canvas";
import { getErrorMessage } from "@/utils";

interface MediaState {
  scopeKey: string | null;
  nodes: CanvasNodeProjection[];
  edges: MediaEdge[];
  loading: boolean;
  error: string | null;
  refreshGeneration: number;
  lastQuery: { workspaceId: string | null; layoutId: string | null; queryLayoutId: string | null } | null;
  refresh: (workspaceId: string | null, layoutId: string | null, queryLayoutId?: string | null) => Promise<void>;
  /** Re-run the last refresh; used by inline node editors after a mutation. */
  refreshCurrent: () => Promise<void>;
  clear: () => void;
}

function timestamp(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Select the newest persisted run even if an API adapter returns unsorted rows. */
export function latestMediaRun(runs: MediaRun[]): MediaRun | undefined {
  return [...runs].sort((left, right) => {
    const created = timestamp(right.createdAt) - timestamp(left.createdAt);
    if (created !== 0) return created;
    const updated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
    if (updated !== 0) return updated;
    return right.id.localeCompare(left.id);
  })[0];
}

async function projectNode(node: MediaNode): Promise<CanvasNodeProjection> {
  // Subtype nodes (text/script/audio/board/storyboard) never own runs; skip
  // the run/asset queries entirely.
  if (mediaNodeSubtype(node.parameters)) return toCanvasMediaNode(node);
  const runs = await mediaService.listRuns(node.id, 20);
  const run = latestMediaRun(runs);
  if (!run) return toCanvasMediaNode(node);
  const assets = await mediaService.listAssets(node.workspaceId, run.id);
  const outputIds = new Set(run.outputAssetIds);
  const outputs = assets.filter((candidate) => outputIds.has(candidate.id));
  const asset = outputs.find((candidate) => {
    const role = candidate.metadata.role ?? candidate.metadata.assetRole;
    return role !== "poster" && isMediaMimeCompatible(node.kind, candidate.mimeType);
  }) ?? outputs.find((candidate) => candidate.metadata.role !== "poster") ?? assets[0];
  if (!asset) return toCanvasMediaNode(node, run);
  const poster = node.kind === "video"
    ? outputs.find((candidate) => {
      const role = candidate.metadata.role ?? candidate.metadata.assetRole;
      return role === "poster" && candidate.mimeType.toLowerCase().startsWith("image/");
    })
    : undefined;
  const metadataUrls = [asset.metadata.previewUrl, asset.metadata.url]
    .filter((value): value is string => typeof value === "string");
  const safeInlinePreview = metadataUrls.find(isMediaPreviewUrl)
    ?? (isMediaPreviewUrl(asset.relativePath) ? asset.relativePath : undefined);
  const previewUrl = safeInlinePreview
    ?? await mediaService.resolveAssetUrl(asset.id).catch(() => undefined);
  const posterUrl = poster
    ? await mediaService.resolveAssetUrl(poster.id).catch(() => undefined)
    : undefined;
  return toCanvasMediaNode(
    node,
    run,
    previewUrl
      ? { ...asset, metadata: { ...asset.metadata, previewUrl, ...(posterUrl ? { posterUrl } : {}) } }
      : asset,
  );
}

export const useMediaStore = create<MediaState>((set, get) => ({
  scopeKey: null,
  nodes: [],
  edges: [],
  loading: false,
  error: null,
  // Incremented for every refresh/clear so an older request cannot overwrite
  // a newer result when the five-second poll overlaps a slow API response.
  refreshGeneration: 0,
  lastQuery: null,
  refresh: async (workspaceId, layoutId, queryLayoutId = layoutId) => {
    if (!workspaceId || !layoutId) {
      get().clear();
      return;
    }
    const scopeKey = JSON.stringify([workspaceId, layoutId]);
    const requestGeneration = get().refreshGeneration + 1;
    set({ scopeKey, loading: true, error: null, refreshGeneration: requestGeneration, lastQuery: { workspaceId, layoutId, queryLayoutId: queryLayoutId ?? null } });
    try {
      const [nodes, edges] = await Promise.all([
        mediaService.listNodes(workspaceId, queryLayoutId ?? undefined),
        typeof mediaService.listEdges === "function"
          ? mediaService.listEdges(workspaceId, queryLayoutId ?? undefined).catch(() => [] as MediaEdge[])
          : Promise.resolve([] as MediaEdge[]),
      ]);
      const projected = await Promise.all(nodes.map(projectNode));
      if (get().scopeKey !== scopeKey || get().refreshGeneration !== requestGeneration) return;
      set({ nodes: projected, edges, loading: false, error: null });
    } catch (error) {
      if (get().scopeKey !== scopeKey || get().refreshGeneration !== requestGeneration) return;
      set({ loading: false, error: getErrorMessage(error) });
    }
  },
  refreshCurrent: async () => {
    const last = get().lastQuery;
    if (!last) return;
    await get().refresh(last.workspaceId, last.layoutId, last.queryLayoutId);
  },
  clear: () => set((state) => ({
    scopeKey: null,
    nodes: [],
    edges: [],
    loading: false,
    error: null,
    refreshGeneration: state.refreshGeneration + 1,
    lastQuery: null,
  })),
}));
