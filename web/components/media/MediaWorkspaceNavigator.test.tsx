import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MediaWorkspaceNavigator from "./MediaWorkspaceNavigator";

const fixture = vi.hoisted(() => ({
  state: {
    workspaces: [{
      id: "workspace-a",
      name: "Workspace A",
      createdAt: "2026-08-26T00:00:00.000Z",
      projects: [{ id: "project-a", path: "C:/workspace-a/project-a", alias: "Project A" }],
    }],
    loading: false,
    load: vi.fn(),
    create: vi.fn(),
    addProject: vi.fn(),
  },
}));

vi.mock("@/stores", () => ({
  useWorkspacesStore: (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
}));

describe("MediaWorkspaceNavigator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps project import and Canvas creation in the matching context menus", async () => {
    const onCreateCanvas = vi.fn();
    render(
      <MediaWorkspaceNavigator
        workspaceId="workspace-a"
        projectId="project-a"
        onWorkspaceChange={vi.fn()}
        onProjectChange={vi.fn()}
        onCreateCanvas={onCreateCanvas}
      />,
    );

    expect(screen.queryByText("导入项目")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("button", { name: /Workspace A/ }));
    expect(await screen.findByText("导入项目")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("创建工作空间 Canvas"));
    expect(onCreateCanvas).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", projectId: null });

    fireEvent.contextMenu(screen.getByRole("button", { name: /Project A/ }));
    fireEvent.click(await screen.findByText("创建项目 Canvas"));
    expect(onCreateCanvas).toHaveBeenLastCalledWith({ workspaceId: "workspace-a", projectId: "project-a" });
  });
});
