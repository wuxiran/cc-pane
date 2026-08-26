import { beforeEach, describe, expect, it } from "vitest";
import { useMediaStudioStore, type MediaStudioSelection } from "./useMediaStudioStore";

const emptySelection = (): MediaStudioSelection => ({
  workspaceId: null,
  projectId: null,
  providerId: null,
  modelId: null,
  protocol: "open_ai_compatible",
});

describe("useMediaStudioStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useMediaStudioStore.setState({
      selections: {
        image: emptySelection(),
        video: emptySelection(),
      },
    });
  });

  it("keeps one workspace/project root shared by image and video", () => {
    useMediaStudioStore.getState().setSelection("image", {
      workspaceId: "workspace-a",
      projectId: "project-a",
      providerId: "image-provider",
      modelId: "image-model",
    });

    expect(useMediaStudioStore.getState().selections).toMatchObject({
      image: {
        workspaceId: "workspace-a",
        projectId: "project-a",
        providerId: "image-provider",
        modelId: "image-model",
      },
      video: {
        workspaceId: "workspace-a",
        projectId: "project-a",
        providerId: null,
        modelId: null,
      },
    });

    useMediaStudioStore.getState().setSelection("video", {
      workspaceId: "workspace-b",
      projectId: "project-b",
      providerId: "video-provider",
      modelId: "video-model",
      protocol: "comfyui",
    });

    expect(useMediaStudioStore.getState().selections.image).toMatchObject({
      workspaceId: "workspace-b",
      projectId: "project-b",
      providerId: "image-provider",
      modelId: "image-model",
    });
    expect(useMediaStudioStore.getState().selections.video).toMatchObject({
      workspaceId: "workspace-b",
      projectId: "project-b",
      providerId: "video-provider",
      modelId: "video-model",
      protocol: "comfyui",
    });
  });

  it("does not reset the shared root when a mode provider is reset", () => {
    useMediaStudioStore.getState().setSelection("image", {
      workspaceId: "workspace-a",
      projectId: "project-a",
      providerId: "provider-a",
      modelId: "model-a",
    });

    useMediaStudioStore.getState().resetSelection("image");

    expect(useMediaStudioStore.getState().selections.image).toEqual({
      ...emptySelection(),
      workspaceId: "workspace-a",
      projectId: "project-a",
    });
    expect(useMediaStudioStore.getState().selections.video).toMatchObject({
      workspaceId: "workspace-a",
      projectId: "project-a",
    });
  });

  it("persists the same root for both modes while keeping provider settings separate", () => {
    useMediaStudioStore.getState().setSelection("image", {
      workspaceId: "workspace-a",
      projectId: "project-a",
      providerId: "image-provider",
      modelId: "image-model",
    });
    useMediaStudioStore.getState().setSelection("video", {
      providerId: "video-provider",
      modelId: "video-model",
      protocol: "sub2api",
    });

    const persisted = JSON.parse(localStorage.getItem("cc-panes-media-studio") ?? "null");
    expect(persisted.state.selections.image).toMatchObject({
      workspaceId: "workspace-a",
      projectId: "project-a",
      providerId: "image-provider",
    });
    expect(persisted.state.selections.video).toMatchObject({
      workspaceId: "workspace-a",
      projectId: "project-a",
      providerId: "video-provider",
      protocol: "sub2api",
    });
  });
});
