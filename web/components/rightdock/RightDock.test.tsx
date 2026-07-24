import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRightDockStore } from "@/stores/useRightDockStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { Workspace } from "@/types";
import RightDock from "./RightDock";

vi.mock("@/components/sidebar/ExplorerGitSection", () => ({
  default: ({ selectedProjectId }: { selectedProjectId: string | null }) => (
    <div data-testid="right-dock-git">{selectedProjectId}</div>
  ),
}));

vi.mock("@/components/sidebar/ExplorerFilesSection", () => ({
  default: ({ selectedProjectId }: { selectedProjectId: string | null }) => (
    <div data-testid="right-dock-files">{selectedProjectId}</div>
  ),
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "Workspace One",
  createdAt: "2026-07-24T00:00:00Z",
  projects: [
    { id: "project-1", path: "/workspace/alpha", alias: "Alpha" },
  ],
};

function renderDock() {
  return render(
    <TooltipProvider>
      <RightDock />
    </TooltipProvider>,
  );
}

describe("RightDock", () => {
  beforeEach(() => {
    localStorage.clear();
    useRightDockStore.setState({ visible: true, activeView: "git", width: 340 });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      expandedWorkspaceId: workspace.id,
      expandedProjectId: "project-1",
    });
  });

  it("无选中项目时显示空态，不挂载住户", () => {
    useWorkspacesStore.setState({ expandedProjectId: null });

    renderDock();

    expect(screen.getByText("请在左侧选择项目")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-git")).not.toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-files")).not.toBeInTheDocument();
  });

  it("Git 视图显示当前项目名并直挂 Git section", () => {
    renderDock();

    expect(screen.getByTestId("right-dock-panel")).toHaveStyle({ width: "340px" });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByTestId("right-dock-git")).toHaveTextContent("project-1");
    expect(screen.queryByTestId("right-dock-files")).not.toBeInTheDocument();
  });

  it("文件视图直挂文件 section", () => {
    useRightDockStore.setState({ activeView: "files" });

    renderDock();

    expect(screen.getByTestId("right-dock-files")).toHaveTextContent("project-1");
    expect(screen.queryByTestId("right-dock-git")).not.toBeInTheDocument();
  });

  it("折叠时不再渲染面板或常驻图标条", () => {
    useRightDockStore.setState({ visible: false, activeView: "git" });

    renderDock();

    expect(screen.queryByTestId("right-dock-panel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Git" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "文件" })).not.toBeInTheDocument();
  });

  it("在面板内切换 Git 与文件视图且不折叠", async () => {
    const user = userEvent.setup();
    renderDock();

    const gitTab = screen.getByRole("tab", { name: "Git" });
    const filesTab = screen.getByRole("tab", { name: "文件" });
    expect(gitTab).toHaveAttribute("aria-selected", "true");
    expect(filesTab).toHaveAttribute("aria-selected", "false");

    await user.click(filesTab);
    expect(useRightDockStore.getState()).toMatchObject({ visible: true, activeView: "files" });
    expect(screen.getByTestId("right-dock-files")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "文件" }));
    expect(useRightDockStore.getState().visible).toBe(true);
  });

  it("双击拖柄可折叠", () => {
    renderDock();

    fireEvent.doubleClick(screen.getByRole("separator", { name: "调整右侧面板宽度" }));
    expect(screen.queryByTestId("right-dock-panel")).not.toBeInTheDocument();
  });

  it("从左缘向左拖动会增宽，并在抬起时持久化钳制后的宽度", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    renderDock();
    const panel = screen.getByTestId("right-dock-panel");
    const sash = screen.getByRole("separator", { name: "调整右侧面板宽度" });

    fireEvent.pointerDown(sash, { clientX: 500 });
    fireEvent.pointerMove(document, { clientX: 400 });
    expect(panel).toHaveStyle({ width: "440px" });

    fireEvent.pointerMove(document, { clientX: -100 });
    expect(panel).toHaveStyle({ width: "560px" });

    fireEvent.pointerUp(document);
    expect(useRightDockStore.getState().width).toBe(560);
  });
});
