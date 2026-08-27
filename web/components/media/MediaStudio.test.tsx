import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaService } from "@/services/mediaService";
import type { MediaInputAssetSelection } from "@/types/media";
import MediaStudio from "./MediaStudio";

const fixture = vi.hoisted(() => ({
  selection: {
    workspaceId: "workspace-1",
    projectId: "project-1",
    providerId: "provider-1",
    modelId: "model-1",
    protocol: "open_ai_compatible",
  },
  source: {
    assetId: "source-asset",
    sourceNodeId: "source-node",
    sourceRunId: "source-run",
    mediaKind: "image",
    name: "source.png",
    mimeType: "image/png",
  } satisfies MediaInputAssetSelection,
  workspace: {
    id: "workspace-1",
    name: "Workspace",
    path: "C:/media-workspace",
    projects: [{
      id: "project-1",
      path: "C:/media-workspace/project",
    }],
  },
}));

vi.mock("@/stores", () => ({
  useMediaStore: (selector: (state: { nodes: [] }) => unknown) => selector({ nodes: [] }),
  useMediaStudioStore: (selector: (state: { selections: { image: typeof fixture.selection; video: typeof fixture.selection }; setSelection: ReturnType<typeof vi.fn> }) => unknown) => selector({
    selections: { image: fixture.selection, video: fixture.selection },
    setSelection: vi.fn(),
  }),
  useWorkspacesStore: (selector: (state: { workspaces: typeof fixture.workspace[]; updateWorkspaceProvider: ReturnType<typeof vi.fn> }) => unknown) => selector({
    workspaces: [fixture.workspace],
    updateWorkspaceProvider: vi.fn(),
  }),
}));

vi.mock("@/services/mediaService", () => ({
  mediaService: {
    listNodes: vi.fn(),
    getProviderCapabilities: vi.fn(),
    stageInput: vi.fn(),
    createNode: vi.fn(),
    createRun: vi.fn(),
    createEdge: vi.fn(),
  },
}));

vi.mock("./MediaWorkspaceNavigator", () => ({ default: () => null }));
vi.mock("./MediaProviderSection", () => ({
  default: ({ capabilities }: { capabilities?: { operations: string[] } | null }) => (
    <span data-testid="mock-capabilities">{capabilities?.operations.join(",")}</span>
  ),
}));
vi.mock("./MediaCanvasView", () => ({ default: () => null }));
vi.mock("./MediaHistoryPanel", () => ({
  default: ({ onUseOutput }: { onUseOutput: (selection: MediaInputAssetSelection) => void }) => (
    <button type="button" onClick={() => onUseOutput(fixture.source)}>Select upstream output</button>
  ),
}));
vi.mock("./MediaGenerationForm", () => ({
  default: ({ linkedInput, onGenerate }: { linkedInput?: MediaInputAssetSelection | null; onGenerate: (values: Record<string, unknown>) => Promise<void> }) => (
    <button
      type="button"
      disabled={!linkedInput}
      onClick={() => void onGenerate({
        operation: "imageToVideo",
        prompt: "camera motion",
        inputFiles: [],
        inputAssetIds: linkedInput ? [linkedInput.assetId] : [],
        linkedInput,
        parameters: {},
        priority: 0,
      })}
    >
      Generate linked video
    </button>
  ),
}));

const service = vi.mocked(mediaService);

describe("MediaStudio linked generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.listNodes.mockResolvedValue([]);
    service.getProviderCapabilities.mockResolvedValue({
      providerId: "provider-1",
      protocol: "open_ai_compatible",
      kinds: ["image", "video"],
      operations: ["imageToVideo"],
      supportsAsyncJobs: true,
      supportsCancel: true,
    });
    service.createNode.mockResolvedValue({ id: "target-node" } as never);
    service.createRun.mockResolvedValue({ id: "target-run" } as never);
    service.createEdge.mockResolvedValue({ id: "edge-1" } as never);
  });

  it("writes a fixed upstream asset edge when generating a linked video", async () => {
    render(<MediaStudio kind="video" />);

    fireEvent.click(screen.getByRole("button", { name: "Select upstream output" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate linked video" }));

    await waitFor(() => expect(service.createRun).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: "target-node",
      inputAssetIds: ["source-asset"],
    })));
    expect(service.createNode).toHaveBeenCalledWith(expect.objectContaining({
      layoutId: "media-workspace-1-project-1",
      kind: "video",
      mediaScope: {
        workspaceId: "workspace-1",
        projectId: "project-1",
        projectPath: "C:/media-workspace/project",
      },
    }));
    expect(service.createRun).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        mediaScope: {
          workspaceId: "workspace-1",
          projectId: "project-1",
          projectPath: "C:/media-workspace/project",
        },
      }),
    }));
    expect(service.createEdge).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      layoutId: "media-workspace-1-project-1",
      sourceNodeId: "source-node",
      sourcePort: "output",
      targetNodeId: "target-node",
      targetPort: "reference",
      selector: "specificAsset",
      assetId: "source-asset",
    });
  });

  it("does not retain a selected upstream output when the provider lacks image-to-video", async () => {
    service.getProviderCapabilities.mockResolvedValue({
      providerId: "provider-1",
      protocol: "open_ai_compatible",
      kinds: ["video"],
      operations: ["textToVideo"],
      supportsAsyncJobs: true,
      supportsCancel: true,
    });
    render(<MediaStudio kind="video" />);

    await screen.findByText("textToVideo");
    fireEvent.click(screen.getByRole("button", { name: "Select upstream output" }));

    expect(screen.getByRole("button", { name: "Generate linked video" })).toBeDisabled();
    expect(service.createEdge).not.toHaveBeenCalled();
  });

  it("uses one media workspace header to switch between image and video", async () => {
    const onKindChange = vi.fn();
    render(<MediaStudio kind="image" onKindChange={onKindChange} />);

    expect(screen.getByTestId("media-studio-image")).toHaveClass("flex-1");
    expect(screen.getByRole("tab", { name: /生图/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: /生视频/ }));

    await waitFor(() => expect(onKindChange).toHaveBeenCalledWith("video"));
  });
});
