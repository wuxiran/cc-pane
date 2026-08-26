import { beforeEach, describe, expect, it } from "vitest";
import { legacyMediaLayoutId, useMediaCanvasStore } from "./useMediaCanvasStore";

describe("useMediaCanvasStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useMediaCanvasStore.setState({ spaces: [], activeSpaceIds: {} });
  });

  it("creates named Canvas spaces and selects the most recently created one", () => {
    const first = useMediaCanvasStore.getState().createSpace({
      workspaceId: "workspace-a",
      projectId: "project-a",
      name: "空间 1",
    });
    const second = useMediaCanvasStore.getState().createSpace({
      workspaceId: "workspace-a",
      name: "空间 2",
    });

    expect(useMediaCanvasStore.getState()).toMatchObject({
      activeSpaceIds: { "workspace-a": second.id },
      spaces: [
        { id: first.id, name: "空间 1", scope: "project", projectId: "project-a" },
        { id: second.id, name: "空间 2", scope: "workspace", projectId: null },
      ],
    });

    useMediaCanvasStore.getState().activateSpace(first.id);
    expect(useMediaCanvasStore.getState().activeSpaceIds["workspace-a"]).toBe(first.id);
  });

  it("adopts the existing project graph as the first named space", () => {
    const space = useMediaCanvasStore.getState().ensureProjectSpace({
      workspaceId: "workspace-a",
      projectId: "project-a",
      name: "空间 1",
    });

    expect(space).toMatchObject({
      name: "空间 1",
      scope: "project",
      layoutId: legacyMediaLayoutId("workspace-a", "project-a"),
    });
    expect(useMediaCanvasStore.getState().activeSpaceIds["workspace-a"]).toBe(space.id);
  });

  it("keeps a workspace Canvas active while switching the selected project", () => {
    const workspaceSpace = useMediaCanvasStore.getState().createSpace({
      workspaceId: "workspace-a",
      name: "空间 1",
    });

    const selected = useMediaCanvasStore.getState().ensureProjectSpace({
      workspaceId: "workspace-a",
      projectId: "project-b",
      name: "空间 2",
    });

    expect(selected.id).toBe(workspaceSpace.id);
    expect(useMediaCanvasStore.getState().spaces).toHaveLength(1);
  });

  it("persists spaces without storing any runtime media state", () => {
    useMediaCanvasStore.getState().createSpace({
      workspaceId: "workspace-a",
      projectId: "project-a",
      name: "空间 1",
    });

    const persisted = JSON.parse(localStorage.getItem("cc-panes-media-canvas-spaces") ?? "null");
    expect(persisted.state).toMatchObject({
      spaces: [{ name: "空间 1", workspaceId: "workspace-a" }],
    });
    expect(persisted.state).not.toHaveProperty("createSpace");
  });
});
