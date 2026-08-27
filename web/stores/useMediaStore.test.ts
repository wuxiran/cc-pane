import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaService } from "@/services/mediaService";
import type { MediaAsset, MediaNode, MediaRun } from "@/types/media";
import { latestMediaRun, useMediaStore } from "./useMediaStore";

vi.mock("@/services/mediaService", () => ({
  mediaService: {
    listNodes: vi.fn(),
    listRuns: vi.fn(),
    listAssets: vi.fn(),
    resolveAssetUrl: vi.fn(),
    listEdges: vi.fn(),
  },
}));

const service = vi.mocked(mediaService);

const node: MediaNode = {
  id: "node-1",
  workspaceId: "workspace-1",
  layoutId: "layout-1",
  kind: "image",
  title: "Poster",
  defaultOperation: "textToImage",
  parameters: {},
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

const run = (id: string, createdAt: string, updatedAt = createdAt): MediaRun => ({
  id,
  nodeId: node.id,
  operation: "textToImage",
  status: "processing",
  attempt: 1,
  priority: 0,
  cachePolicy: "read_write",
  cacheHit: false,
  request: {},
  inputAssetIds: [],
  outputAssetIds: [],
  createdAt,
  updatedAt,
});

const asset: MediaAsset = {
  id: "asset-1",
  workspaceId: node.workspaceId,
  runId: "run-new",
  relativePath: "workspace-1/asset-1.png",
  mimeType: "image/png",
  sizeBytes: 4,
  metadata: {},
  createdAt: "2026-08-25T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useMediaStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMediaStore.setState({ scopeKey: null, nodes: [], edges: [], loading: false, error: null, refreshGeneration: 0 });
    service.listRuns.mockResolvedValue([]);
    service.listAssets.mockResolvedValue([]);
    service.listEdges.mockResolvedValue([]);
  });

  it("chooses the newest run even when the adapter returns rows out of order", () => {
    expect(latestMediaRun([
      run("old", "2026-08-25T01:00:00.000Z"),
      run("new", "2026-08-25T02:00:00.000Z"),
    ])?.id).toBe("new");
  });

  it("resolves a persisted local asset into a Canvas preview URL", async () => {
    service.listNodes.mockResolvedValue([node]);
    service.listRuns.mockResolvedValue([run("run-new", "2026-08-25T02:00:00.000Z")]);
    service.listAssets.mockResolvedValue([asset]);
    service.resolveAssetUrl.mockResolvedValue("asset://localhost/media/asset-1.png");

    await useMediaStore.getState().refresh(node.workspaceId, node.layoutId);

    expect(useMediaStore.getState().nodes[0]).toMatchObject({
      id: "media:node-1",
      status: "running",
      media: {
        previewUrl: "asset://localhost/media/asset-1.png",
        runStatus: "processing",
      },
    });
  });

  it("rejects an unsafe metadata URL and falls back to the validated asset resolver", async () => {
    service.listNodes.mockResolvedValue([node]);
    service.listRuns.mockResolvedValue([run("run-new", "2026-08-25T02:00:00.000Z")]);
    service.listAssets.mockResolvedValue([{
      ...asset,
      metadata: { previewUrl: "javascript:alert(1)" },
    }]);
    service.resolveAssetUrl.mockResolvedValue("/api/media/assets/asset-1/content");

    await useMediaStore.getState().refresh(node.workspaceId, node.layoutId);

    expect(service.resolveAssetUrl).toHaveBeenCalledWith("asset-1");
    expect(useMediaStore.getState().nodes[0]?.media?.previewUrl).toBe("/api/media/assets/asset-1/content");
  });

  it("uses a safe secondary metadata URL when the preferred field is invalid", async () => {
    service.listNodes.mockResolvedValue([node]);
    service.listRuns.mockResolvedValue([run("run-new", "2026-08-25T02:00:00.000Z")]);
    service.listAssets.mockResolvedValue([{
      ...asset,
      metadata: {
        previewUrl: "javascript:alert(1)",
        url: "/api/media/assets/asset-1/content",
      },
    }]);

    await useMediaStore.getState().refresh(node.workspaceId, node.layoutId);

    expect(service.resolveAssetUrl).not.toHaveBeenCalled();
    expect(useMediaStore.getState().nodes[0]?.media?.previewUrl).toBe("/api/media/assets/asset-1/content");
  });

  it("keeps a video poster separate and resolves it for the native video element", async () => {
    const videoNode: MediaNode = {
      ...node,
      id: "video-node",
      kind: "video",
      defaultOperation: "textToVideo",
    };
    const videoRun: MediaRun = {
      ...run("video-run", "2026-08-25T02:00:00.000Z"),
      nodeId: videoNode.id,
      operation: "textToVideo",
      status: "succeeded",
      outputAssetIds: ["video-asset", "poster-asset"],
    };
    service.listNodes.mockResolvedValue([videoNode]);
    service.listRuns.mockResolvedValue([videoRun]);
    service.listAssets.mockResolvedValue([
      { ...asset, id: "video-asset", runId: videoRun.id, mimeType: "video/mp4", relativePath: "workspace-1/video.mp4", metadata: { fps: 24 } },
      { ...asset, id: "poster-asset", runId: videoRun.id, mimeType: "image/png", relativePath: "workspace-1/poster.png", metadata: { role: "poster" } },
    ]);
    service.resolveAssetUrl.mockImplementation(async (assetId) => `/api/media/assets/${assetId}/content`);

    await useMediaStore.getState().refresh(videoNode.workspaceId, videoNode.layoutId);

    expect(service.resolveAssetUrl).toHaveBeenCalledWith("video-asset");
    expect(service.resolveAssetUrl).toHaveBeenCalledWith("poster-asset");
    expect(useMediaStore.getState().nodes[0]?.media).toMatchObject({
      previewUrl: "/api/media/assets/video-asset/content",
      posterUrl: "/api/media/assets/poster-asset/content",
      fps: 24,
    });
  });

  it("does not let an older same-scope refresh overwrite a newer result", async () => {
    const first = deferred<MediaNode[]>();
    const second = deferred<MediaNode[]>();
    const newerNode = { ...node, title: "Newer" };
    service.listNodes
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const oldRefresh = useMediaStore.getState().refresh(node.workspaceId, node.layoutId);
    const newRefresh = useMediaStore.getState().refresh(node.workspaceId, node.layoutId);
    second.resolve([newerNode]);
    await newRefresh;
    first.resolve([node]);
    await oldRefresh;

    expect(useMediaStore.getState().nodes[0]?.label).toBe("Newer");
  });

  it("refreshes persisted media edges with the active layout", async () => {
    service.listNodes.mockResolvedValue([]);
    service.listEdges.mockResolvedValue([{
      id: "edge-1",
      workspaceId: node.workspaceId,
      layoutId: node.layoutId,
      sourceNodeId: "source",
      sourcePort: "image",
      targetNodeId: "target",
      targetPort: "input",
      selector: "latestSucceeded",
      createdAt: "2026-08-25T00:00:00.000Z",
    }]);

    await useMediaStore.getState().refresh(node.workspaceId, node.layoutId);

    expect(service.listEdges).toHaveBeenCalledWith(node.workspaceId, node.layoutId);
    expect(useMediaStore.getState().edges).toHaveLength(1);
  });

  it("loads every project graph for a workspace Canvas while keeping a logical space key", async () => {
    service.listNodes.mockResolvedValue([
      node,
      { ...node, id: "node-2", layoutId: "media-workspace-1-project-2" },
    ]);
    service.listEdges.mockResolvedValue([]);

    await useMediaStore.getState().refresh("workspace-1", "media-canvas-space-1", null);

    expect(service.listNodes).toHaveBeenCalledWith("workspace-1", undefined);
    expect(service.listEdges).toHaveBeenCalledWith("workspace-1", undefined);
    expect(useMediaStore.getState().scopeKey).toBe(
      JSON.stringify(["workspace-1", "media-canvas-space-1"]),
    );
    expect(useMediaStore.getState().nodes).toHaveLength(2);
  });
});
