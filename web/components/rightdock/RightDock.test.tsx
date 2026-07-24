import "@/i18n";
import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRightDockStore } from "@/stores/useRightDockStore";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import {
  createDefaultModulePreferences,
  useModulePrefsStore,
} from "@/stores/useModulePrefsStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { OpenTerminalOptions, Workspace } from "@/types";
import RightDock from "./RightDock";

vi.mock("@/components/sidebar/ExplorerGitSection", () => ({
  default: ({
    selectedProjectId,
    onSelectedProjectSummaryChange,
  }: {
    selectedProjectId: string | null;
    onSelectedProjectSummaryChange?: (summary: {
      kind: "git";
      branch: string;
      changeCount: number;
    }) => void;
  }) => {
    useEffect(() => {
      onSelectedProjectSummaryChange?.({
        kind: "git",
        branch: "feature/rightdock",
        changeCount: 3,
      });
    }, [onSelectedProjectSummaryChange]);
    return <div data-testid="right-dock-git">{selectedProjectId}</div>;
  },
}));

vi.mock("@/components/sidebar/ExplorerFilesSection", () => ({
  default: ({ selectedProjectId }: { selectedProjectId: string | null }) => (
    <div data-testid="right-dock-files">{selectedProjectId}</div>
  ),
}));

vi.mock("@/components/sidebar/SshMachinesView", () => ({
  default: ({ onOpenTerminal }: { onOpenTerminal: (options: OpenTerminalOptions) => void }) => (
    <button
      type="button"
      data-testid="right-dock-ssh"
      onClick={() => onOpenTerminal({ path: "ssh://host/project" } as OpenTerminalOptions)}
    >
      SSH
    </button>
  ),
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "Workspace One",
  createdAt: "2026-07-24T00:00:00Z",
  projects: [
    { id: "project-1", path: "/workspace/alpha", alias: "Alpha" },
    { id: "project-2", path: "/workspace/beta", alias: "Beta" },
  ],
};

function renderDock(onOpenTerminal = vi.fn()) {
  return render(
    <TooltipProvider>
      <RightDock onOpenTerminal={onOpenTerminal} />
    </TooltipProvider>,
  );
}

describe("RightDock", () => {
  beforeEach(() => {
    localStorage.clear();
    useRightDockStore.setState({ visible: true, activeView: "git", width: 340 });
    useActivityBarStore.setState({
      activeView: "explorer",
      sidebarVisible: true,
      appViewMode: "panes",
      orchestrationOverlayOpen: false,
    });
    useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      expandedWorkspaceId: workspace.id,
      expandedProjectId: "project-1",
    });
  });

  it("多项目工作空间无显式选中时兜底第一个项目", () => {
    useWorkspacesStore.setState({ expandedProjectId: null });

    renderDock();

    expect(screen.getByTestId("right-dock-git")).toHaveTextContent("project-1");
    expect(screen.queryByText("工作空间中没有项目")).not.toBeInTheDocument();
  });

  it("显式选中的项目优先于首项目兜底", () => {
    useWorkspacesStore.setState({ expandedProjectId: "project-2" });

    renderDock();

    expect(screen.getByTestId("right-dock-git")).toHaveTextContent("project-2");
  });

  it("选中项目已不在工作空间时回退第一个项目", () => {
    useWorkspacesStore.setState({ expandedProjectId: "removed-project" });

    renderDock();

    expect(screen.getByTestId("right-dock-git")).toHaveTextContent("project-1");
  });

  it("工作空间没有项目时才显示空态", () => {
    useWorkspacesStore.setState({
      workspaces: [{ ...workspace, projects: [] }],
      expandedProjectId: null,
    });

    renderDock();

    expect(screen.getByText("工作空间中没有项目")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-git")).not.toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-files")).not.toBeInTheDocument();
  });

  it("Git 视图直挂 Git section", () => {
    renderDock();

    expect(screen.getByTestId("right-dock-panel")).toHaveStyle({ width: "340px" });
    expect(screen.getByTestId("right-dock-git")).toHaveTextContent("project-1");
    expect(screen.queryByTestId("right-dock-files")).not.toBeInTheDocument();
  });

  it("文件视图直挂文件 section", () => {
    useRightDockStore.setState({ activeView: "files" });

    renderDock();

    expect(screen.getByTestId("right-dock-files")).toHaveTextContent("project-1");
    expect(screen.getByTestId("right-dock-git")).not.toBeVisible();
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

  it("只为启用且位于右坞的模块注册扩展 tab", () => {
    useModulePrefsStore.getState().setPosition("ssh", "rightDock");
    useModulePrefsStore.getState().setPosition("resources", "rightDock");
    useModulePrefsStore.getState().setPosition("todo", "hidden");
    useModulePrefsStore.getState().setEnabled("orchestration", false);

    renderDock();

    expect(screen.getByRole("tab", { name: "SSH 机器" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "资源中心" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "TodoList" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "任务编排" })).not.toBeInTheDocument();
  });

  it("SSH tab 驻留坞内并复用终端打开回调", async () => {
    const user = userEvent.setup();
    const onOpenTerminal = vi.fn();
    useModulePrefsStore.getState().setPosition("ssh", "rightDock");
    renderDock(onOpenTerminal);

    await user.click(screen.getByRole("tab", { name: "SSH 机器" }));

    expect(useRightDockStore.getState().activeView).toBe("ssh");
    expect(screen.getByTestId("right-dock-ssh")).toBeInTheDocument();
    expect(screen.queryByTestId("right-dock-git")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("right-dock-ssh"));
    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({
      path: "ssh://host/project",
    }));
  });

  it("非驻留模块 tab 按下即打开原全屏形态且不抢占当前 tab", async () => {
    const user = userEvent.setup();
    useModulePrefsStore.getState().setPosition("resources", "rightDock");
    renderDock();

    const resourcesTab = screen.getByRole("tab", { name: "资源中心" });
    await user.click(resourcesTab);

    expect(useActivityBarStore.getState().appViewMode).toBe("resources");
    expect(useRightDockStore.getState().activeView).toBe("git");
    expect(resourcesTab).toHaveAttribute("aria-selected", "false");
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
