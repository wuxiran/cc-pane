import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNodeProjection } from "@/types/canvas";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/services/mediaService", () => ({
  mediaService: {
    deleteNode: vi.fn(async () => true),
    updateNode: vi.fn(async () => ({})),
    replayRun: vi.fn(async () => ({})),
    resolveAssetUrl: vi.fn(async () => "https://cdn.example/asset.png"),
    revealAsset: vi.fn(async () => {}),
    deleteEdge: vi.fn(async () => true),
  },
}));
const refreshCurrent = vi.fn(async () => {});
const storeState = { refreshCurrent, edges: [] as { id: string; sourceNodeId: string; targetNodeId: string }[] };
vi.mock("@/stores/useMediaStore", () => ({
  useMediaStore: { getState: () => storeState },
}));

const { toast } = await import("sonner");
const { mediaService } = await import("@/services/mediaService");
const actions = await import("./mediaNodeActions");

function node(patch: Partial<CanvasNodeProjection> = {}): CanvasNodeProjection {
  return { id: "media:n1", label: "Poster", kind: "media", ...patch } as CanvasNodeProjection;
}

describe("mediaNodeActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.edges = [];
  });

  it("durableMediaId 剥掉 media: 前缀，其他 id 原样", () => {
    expect(actions.durableMediaId("media:abc")).toBe("abc");
    expect(actions.durableMediaId("task:abc")).toBe("task:abc");
  });

  it("删除：确认后按 durable id 删并刷新；取消则什么都不做", async () => {
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await actions.deleteMediaNode(node(), "sure?");
    expect(mediaService.deleteNode).not.toHaveBeenCalled();

    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    await actions.deleteMediaNode(node(), "sure?");
    expect(mediaService.deleteNode).toHaveBeenCalledWith("n1");
    expect(refreshCurrent).toHaveBeenCalled();
  });

  it("重命名：空/未变不写，变了才 updateNode", async () => {
    vi.spyOn(window, "prompt").mockReturnValueOnce("Poster");
    await actions.renameMediaNode(node(), "name?");
    expect(mediaService.updateNode).not.toHaveBeenCalled();

    vi.spyOn(window, "prompt").mockReturnValueOnce("  New  ");
    await actions.renameMediaNode(node(), "name?");
    expect(mediaService.updateNode).toHaveBeenCalledWith("n1", { title: "New" });
  });

  it("重跑：没有 runId 报错提示，有则 replayRun", async () => {
    await actions.regenerateMediaNode(node(), "no run");
    expect(toast.error).toHaveBeenCalledWith("no run");
    await actions.regenerateMediaNode(node({ media: { runId: "r1" } as CanvasNodeProjection["media"] }), "no run");
    expect(mediaService.replayRun).toHaveBeenCalledWith("r1");
  });

  it("打开/定位产物：无 assetId 静默跳过；失败进 toast", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await actions.openMediaAsset(node());
    await actions.revealMediaAsset(node());
    expect(open).not.toHaveBeenCalled();

    const withAsset = node({ media: { assetId: "a1" } as CanvasNodeProjection["media"] });
    await actions.openMediaAsset(withAsset);
    expect(open).toHaveBeenCalledWith("https://cdn.example/asset.png", "_blank", "noopener");
    vi.mocked(mediaService.revealAsset).mockRejectedValueOnce(new Error("boom"));
    await actions.revealMediaAsset(withAsset);
    expect(toast.error).toHaveBeenCalledWith("boom");
  });

  it("断边：只删触及该节点的边，删完刷新", async () => {
    storeState.edges = [
      { id: "e1", sourceNodeId: "n1", targetNodeId: "x" },
      { id: "e2", sourceNodeId: "y", targetNodeId: "n1" },
      { id: "e3", sourceNodeId: "y", targetNodeId: "z" },
    ];
    await actions.disconnectMediaNode(node());
    expect(vi.mocked(mediaService.deleteEdge).mock.calls.map((c) => c[0]).sort()).toEqual(["e1", "e2"]);
    expect(refreshCurrent).toHaveBeenCalledTimes(1);
  });
});
