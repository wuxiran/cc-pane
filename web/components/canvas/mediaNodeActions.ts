// 画布上媒体节点的右键动作（删除 / 重命名 / 重跑 / 打开 / 定位 / 断边）。
// 从 CanvasNodeLayer 拆出（行数棘轮）；全部是无 React 依赖的纯动作，错误统一 toast。
import { toastErr } from "@/lib/feedback";
import { mediaService } from "@/services/mediaService";
import { useMediaStore } from "@/stores/useMediaStore";
import type { CanvasNodeProjection } from "@/types/canvas";

export function durableMediaId(projectionId: string): string {
  return projectionId.startsWith("media:") ? projectionId.slice("media:".length) : projectionId;
}

function reportError(error: unknown): void {
  toastErr(error instanceof Error ? error.message : String(error));
}

export async function deleteMediaNode(node: CanvasNodeProjection, confirmMessage: string): Promise<void> {
  if (typeof window !== "undefined" && !window.confirm(confirmMessage)) return;
  try {
    await mediaService.deleteNode(durableMediaId(node.id));
    await useMediaStore.getState().refreshCurrent();
  } catch (error) {
    reportError(error);
  }
}

export async function renameMediaNode(node: CanvasNodeProjection, promptMessage: string): Promise<void> {
  if (typeof window === "undefined") return;
  const next = window.prompt(promptMessage, node.label)?.trim();
  if (!next || next === node.label) return;
  try {
    await mediaService.updateNode(durableMediaId(node.id), { title: next });
    await useMediaStore.getState().refreshCurrent();
  } catch (error) {
    reportError(error);
  }
}

/** Re-run the node's latest run with identical inputs (a new variant run). */
export async function regenerateMediaNode(node: CanvasNodeProjection, noRunMessage: string): Promise<void> {
  const runId = node.media?.runId;
  if (!runId) {
    toastErr(noRunMessage);
    return;
  }
  try {
    await mediaService.replayRun(runId);
    await useMediaStore.getState().refreshCurrent();
  } catch (error) {
    reportError(error);
  }
}

export async function openMediaAsset(node: CanvasNodeProjection): Promise<void> {
  const assetId = node.media?.assetId;
  if (!assetId) return;
  try {
    const url = await mediaService.resolveAssetUrl(assetId);
    window.open(url, "_blank", "noopener");
  } catch (error) {
    reportError(error);
  }
}

export async function revealMediaAsset(node: CanvasNodeProjection): Promise<void> {
  const assetId = node.media?.assetId;
  if (!assetId) return;
  try {
    await mediaService.revealAsset(assetId);
  } catch (error) {
    reportError(error);
  }
}

/** Remove every durable edge touching this node. */
export async function disconnectMediaNode(node: CanvasNodeProjection): Promise<void> {
  const durableId = durableMediaId(node.id);
  const store = useMediaStore.getState();
  const edges = store.edges.filter(
    (edge) => edge.sourceNodeId === durableId || edge.targetNodeId === durableId,
  );
  if (edges.length === 0) return;
  try {
    await Promise.all(edges.map((edge) => mediaService.deleteEdge(edge.id)));
    await store.refreshCurrent();
  } catch (error) {
    reportError(error);
  }
}
