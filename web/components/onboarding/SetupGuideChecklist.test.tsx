import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { skillService } from "@/services/skillService";
import {
  useActivityBarStore,
  useDialogStore,
  useOrchestratorStore,
  useRightDockStore,
  useWorkspacesStore,
} from "@/stores";
import type { InstalledUserSkill, TaskBinding, Workspace } from "@/types";
import SetupGuideChecklist, {
  ONBOARDING_MULTI_LAUNCH_KEY,
} from "./SetupGuideChecklist";
import { notifySetupGuideProgress } from "./setupGuideProgress";

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

const installedSkill = {
  id: "skill-1",
  name: "Dispatch",
  tags: [],
  version: "1.0.0",
  contentSha256: "sha256",
  installedAt: "2026-07-25T00:00:00Z",
} as InstalledUserSkill;

describe("SetupGuideChecklist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useWorkspacesStore.setState({ workspaces: [] });
    useOrchestratorStore.setState({ bindings: [] });
    useActivityBarStore.setState({ orchestrationOverlayOpen: false });
    useRightDockStore.setState({ visible: false, activeView: "git" });
    vi.spyOn(skillService, "listUserSkills").mockResolvedValue([]);
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

    expect(await screen.findByText("0 / 5 已完成")).toBeVisible();
    expect(screen.getAllByText("待完成")).toHaveLength(5);
  });

  it("derives all five completion states from real workspace, launch, task, and skill data", async () => {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useOrchestratorStore.setState({ bindings: [dispatchedTask] });
    localStorage.setItem(ONBOARDING_MULTI_LAUNCH_KEY, "true");
    vi.mocked(skillService.listUserSkills).mockResolvedValue([installedSkill]);

    render(<SetupGuideChecklist />);

    await waitFor(() => expect(screen.getByText("5 / 5 已完成")).toBeVisible());
    expect(screen.getAllByText("已完成")).toHaveLength(5);
  });

  it("does not count an unlaunched task binding as the first dispatch", async () => {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useOrchestratorStore.setState({
      bindings: [{ ...dispatchedTask, sessionId: undefined }],
    });

    render(<SetupGuideChecklist />);

    expect(await screen.findByText("2 / 5 已完成")).toBeVisible();
  });

  it("refreshes completion immediately after a Skill installation event", async () => {
    let installedSkills: InstalledUserSkill[] = [];
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useOrchestratorStore.setState({ bindings: [dispatchedTask] });
    localStorage.setItem(ONBOARDING_MULTI_LAUNCH_KEY, "true");
    vi.mocked(skillService.listUserSkills).mockImplementation(async () => installedSkills);
    render(<SetupGuideChecklist />);
    await waitFor(() => expect(screen.getByText("4 / 5 已完成")).toBeVisible());

    installedSkills = [installedSkill];
    act(() => notifySetupGuideProgress());

    await waitFor(() => expect(screen.getByText("5 / 5 已完成")).toBeVisible());
  });
});
