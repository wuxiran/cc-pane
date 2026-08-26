import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaService } from "@/services/mediaService";
import type { MediaAsset, MediaNode, MediaRun } from "@/types/media";
import MediaHistoryPanel from "./MediaHistoryPanel";

vi.mock("@/services/mediaService", () => ({
  mediaService: {
    listRuns: vi.fn(),
    listAssets: vi.fn(),
    cancelRun: vi.fn(),
    retryRun: vi.fn(),
    replayRun: vi.fn(),
  },
}));

const service = vi.mocked(mediaService);

const node: MediaNode = {
  id: "source-node",
  workspaceId: "workspace-1",
  layoutId: "media-workspace-1-project-1",
  kind: "image",
  title: "Portrait",
  defaultOperation: "textToImage",
  parameters: {},
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const run: MediaRun = {
  id: "source-run",
  nodeId: node.id,
  operation: "textToImage",
  status: "succeeded",
  attempt: 1,
  priority: 0,
  cachePolicy: "read_write",
  cacheHit: false,
  request: {},
  inputAssetIds: [],
  outputAssetIds: ["image-output"],
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:01.000Z",
};

const asset: MediaAsset = {
  id: "image-output",
  workspaceId: node.workspaceId,
  runId: run.id,
  relativePath: "workspace-1/image-output.png",
  mimeType: "image/png",
  sizeBytes: 12,
  metadata: { filename: "portrait.png" },
  createdAt: run.createdAt,
};

describe("MediaHistoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.listRuns.mockResolvedValue([run]);
    service.listAssets.mockResolvedValue([asset]);
  });

  it("passes a succeeded image output into a video generation as a controlled reference", async () => {
    const onUseOutput = vi.fn();
    render(<MediaHistoryPanel nodes={[node]} refreshToken={0} targetKind="video" onUseOutput={onUseOutput} />);

    const button = await screen.findByRole("button", { name: "将生成结果作为参考素材" });
    fireEvent.click(button);

    await waitFor(() => expect(onUseOutput).toHaveBeenCalledWith({
      assetId: asset.id,
      sourceNodeId: node.id,
      sourceRunId: run.id,
      mediaKind: "image",
      name: "portrait.png",
      mimeType: "image/png",
    }));
  });

  it("does not offer a video output to an image-only generation form", async () => {
    render(<MediaHistoryPanel nodes={[{ ...node, kind: "video", defaultOperation: "textToVideo" }]} refreshToken={0} targetKind="image" onUseOutput={vi.fn()} />);

    await screen.findByText("Portrait");
    expect(screen.queryByRole("button", { name: "将生成结果作为参考素材" })).not.toBeInTheDocument();
  });
});
