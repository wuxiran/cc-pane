import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useActivityBarStore,
  useDialogStore,
  useOrchestratorStore,
  useRightDockStore,
  useWorkspacesStore,
} from "@/stores";
import type { TaskBinding, Workspace } from "@/types";
import SetupGuideChecklist, {
  ONBOARDING_MULTI_LAUNCH_KEY,
} from "./SetupGuideChecklist";

const workspace = {
  id: "workspace-1",
  name: "demo",
  projects: [{ id: "project-1", path: "/workspace/demo" }],
} as Workspace;

const dispatchedTask = {
  id: "task-1",
  title: "first task",
  role: "task",
  sessionId: "session-1",
  projectPath: "/workspace/demo",
  cliTool: "claude",
  status: "running",
  progress: 30,
  sortOrder: 0,
  createdAt: "2026-07-25T00:00:00Z",
  updatedAt: "2026-07-25T00:00:00Z",
} as TaskBinding;

describe("SetupGuideChecklist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useWorkspacesStore.setState({ workspaces: [] });
    useOrchestratorStore.setState({ bindings: [] });
    useActivityBarStore.setState({ orchestrationOverlayOpen: false });
    useRightDockStore.setState({ visible: false, activeView: "git" });
  });

  it("opens orchestration in the right dock from the checklist", async () => {
    useActivityBarStore.setState({ orchestrationOverlayOpen: true });
    useDialogStore.setState({ settingsOpen: true });
    render(<SetupGuideChecklist />);

    fireEvent.click(await screen.findByRole("button", { name: /Open orchestration|打开编排/i }));

    expect(useDialogStore.getState().settingsOpen).toBe(false);
    expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(false);
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "orchestration",
    });
  });

  it("shows every core workflow item as pending for a new user", async () => {
    render(<SetupGuideChecklist />);

    expect(await screen.findByText("0 / 4 已完成")).toBeVisible();
    expect(screen.getAllByText("待完成")).toHaveLength(4);
  });

  it("derives all completion states from real workspace, launch, and task data", async () => {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useOrchestratorStore.setState({ bindings: [dispatchedTask] });
    localStorage.setItem(ONBOARDING_MULTI_LAUNCH_KEY, "true");

    render(<SetupGuideChecklist />);

    expect(await screen.findByText("4 / 4 已完成")).toBeVisible();
    expect(screen.getAllByText("已完成")).toHaveLength(4);
  });

  it("does not count an unlaunched task binding as the first dispatch", async () => {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useOrchestratorStore.setState({
      bindings: [{ ...dispatchedTask, sessionId: undefined }],
    });

    render(<SetupGuideChecklist />);

    expect(await screen.findByText("2 / 4 已完成")).toBeVisible();
  });
});
