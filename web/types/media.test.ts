import { describe, expect, it } from "vitest";
import type { MediaNode, MediaAsset } from "./media";
import { classifyComfyNode, isMediaMimeCompatible, isMediaPreviewUrl, jsonFingerprint, parseComfyWorkflow, toCanvasMediaNode } from "./media";

const node: MediaNode = {
  id: "node-1",
  workspaceId: "workspace-1",
  layoutId: "layout-1",
  kind: "image",
  title: "Image",
  defaultOperation: "textToImage",
  parameters: {},
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

const asset: MediaAsset = {
  id: "asset-1",
  workspaceId: node.workspaceId,
  relativePath: "workspace-1/asset-1.png",
  mimeType: "image/png",
  sizeBytes: 10,
  metadata: {},
  createdAt: "2026-08-25T00:00:00.000Z",
};

describe("media Canvas projection safety", () => {
  it("accepts same-origin asset endpoints but rejects provider URLs", () => {
    expect(isMediaPreviewUrl("/api/media/assets/asset-1/content")).toBe(true);
    expect(isMediaPreviewUrl("asset://localhost/workspace-1/asset-1.png")).toBe(true);
    expect(isMediaPreviewUrl("http://asset.localhost/workspace-1/asset-1.png")).toBe(true);
    expect(isMediaPreviewUrl("https://provider.example/generated.png")).toBe(false);
    expect(isMediaPreviewUrl("javascript:alert(1)")).toBe(false);
  });

  it("keeps node and asset media kinds strongly matched", () => {
    expect(isMediaMimeCompatible("image", "image/png")).toBe(true);
    expect(isMediaMimeCompatible("image", "video/mp4")).toBe(false);
    expect(toCanvasMediaNode(node, undefined, { ...asset, mimeType: "video/mp4", metadata: { previewUrl: "/api/media/assets/asset-1/content" } }).media?.previewUrl).toBeUndefined();
  });

  it("projects operation capabilities from the node kind and run state", () => {
    const projection = toCanvasMediaNode(node, {
      id: "run-1",
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
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });

    expect(projection.media?.capabilities).toEqual({
      supportedOperations: ["textToImage", "imageToImage", "edit", "upscale"],
      canRun: false,
      canCancel: true,
      canRetry: false,
    });
  });

  it("projects video poster and normalized playback metadata", () => {
    const videoNode: MediaNode = {
      ...node,
      id: "video-node",
      kind: "video",
      title: "Video",
      defaultOperation: "textToVideo",
    };
    const projection = toCanvasMediaNode(videoNode, undefined, {
      ...asset,
      id: "video-asset",
      mimeType: "video/mp4",
      metadata: {
        previewUrl: "/api/media/assets/video-asset/content",
        posterUrl: "/api/media/assets/poster/content",
        fps: "24",
        frameCount: 120,
        codec: "h264",
        container: "matroska,webm",
        audio: true,
        audioCodec: "aac",
        audioChannels: 2,
        sampleRate: 48000,
        colorSpace: "bt709",
        colorTransfer: "bt709",
        colorPrimaries: "bt709",
        pixelFormat: "yuv420p",
        bitDepth: 8,
        probeStatus: "ok",
      },
      durationMs: 5000,
    });
    expect(projection.media?.posterUrl).toBe("/api/media/assets/poster/content");
    expect(projection.media?.fps).toBe(24);
    expect(projection.media?.frameCount).toBe(120);
    expect(projection.media?.codec).toBe("h264");
    expect(projection.media?.container).toBe("matroska,webm");
    expect(projection.media?.audio).toBe(true);
    expect(projection.media?.audioCodec).toBe("aac");
    expect(projection.media?.audioChannels).toBe(2);
    expect(projection.media?.sampleRate).toBe(48000);
    expect(projection.media?.colorSpace).toBe("bt709");
    expect(projection.media?.pixelFormat).toBe("yuv420p");
    expect(projection.media?.bitDepth).toBe(8);
    expect(projection.media?.probeStatus).toBe("ok");
  });
});

describe("ComfyUI workflow contracts", () => {
  it("discovers LoRA, ControlNet, and IP-Adapter branches from ComfyUI metadata", () => {
    expect(classifyComfyNode("LoraLoader")).toBe("lora");
    expect(classifyComfyNode("custom_apply", { display_name: "Apply ControlNet", category: "conditioning" })).toBe("controlnet");
    expect(classifyComfyNode("custom_condition", { search_aliases: ["IP-Adapter"] })).toBe("ipAdapter");
    expect(classifyComfyNode("KSampler", { category: "sampling" })).toBeNull();
  });

  it("normalizes API workflows and rejects UI blueprints", () => {
    expect(parseComfyWorkflow({
      "1": { class_type: "SaveImage", inputs: {} },
    }).workflow?.["1"].class_type).toBe("SaveImage");
    expect(parseComfyWorkflow({ nodes: [], links: [] }).error).toBe("ui_format");
    expect(parseComfyWorkflow({ prompt: { "1": { class_type: "SaveImage" } } }).workflow?.["1"].inputs).toEqual({});
  });

  it("keeps JSON fingerprints stable when object keys are reordered", async () => {
    const first = await jsonFingerprint({ b: 2, a: { y: true, x: 1 } });
    const second = await jsonFingerprint({ a: { x: 1, y: true }, b: 2 });
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(8);
  });
});
