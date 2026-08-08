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

// AgentConciergeEntry 走 terminalService.checkEnvironment，本测试只关心旅程条本身
vi.mock("./AgentConciergeEntry", () => ({
  default: () => <div data-testid="concierge-entry" />,
}));

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

/** 进度环是完成度的唯一稳定观察点（旅程条节点是 aria-hidden 装饰层） */
function expectProgress(completed: number) {
  return waitFor(() =>
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(completed)),
  );
}

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

  it("opens orchestration in the right dock from the focus card", async () => {
    // 前三步已完成 → 聚焦卡指向「首次派工」，行动按钮 = 打开编排
    useWorkspacesStore.setState({ workspaces: [workspace] });
    localStorage.setItem(ONBOARDING_MULTI_LAUNCH_KEY, "true");
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

  it("shows 0/5 with the tutorial as sole primary CTA for a new user", async () => {
    render(<SetupGuideChecklist />);

    await expectProgress(0);
    // 初始态：开始新手教程是主 CTA，聚焦卡收起（无行动按钮）
    expect(screen.getByTestId("setup-guide-tutorial")).toHaveTextContent(/开始新手教程|Start the tutorial/);
    expect(screen.queryByText(/下一步|Next step/)).toBeNull();
  });

  it("collapses into the done bar when all five states derive complete", async () => {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useOrchestratorStore.setState({ bindings: [dispatchedTask] });
    localStorage.setItem(ONBOARDING_MULTI_LAUNCH_KEY, "true");
    vi.mocked(skillService.listUserSkills).mockResolvedValue([installedSkill]);

    render(<SetupGuideChecklist />);

    await waitFor(() =>
      expect(screen.getByText(/核心路径已走通|Core path complete/)).toBeVisible(),
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("button", { name: /重看引导|Replay guide/ })).toBeVisible();
  });

  it("does not count an unlaunched task binding as the first dispatch", async () => {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useOrchestratorStore.setState({
      bindings: [{ ...dispatchedTask, sessionId: undefined }],
    });

    render(<SetupGuideChecklist />);

    await expectProgress(2);
  });

  it("refreshes completion immediately after a Skill installation event", async () => {
    let installedSkills: InstalledUserSkill[] = [];
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useOrchestratorStore.setState({ bindings: [dispatchedTask] });
    localStorage.setItem(ONBOARDING_MULTI_LAUNCH_KEY, "true");
    vi.mocked(skillService.listUserSkills).mockImplementation(async () => installedSkills);
    render(<SetupGuideChecklist />);
    await expectProgress(4);

    installedSkills = [installedSkill];
    act(() => notifySetupGuideProgress());

    await waitFor(() =>
      expect(screen.getByText(/核心路径已走通|Core path complete/)).toBeVisible(),
    );
  });

  it("keeps the tutorial button reachable while in progress", async () => {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    render(<SetupGuideChecklist />);

    await expectProgress(2);
    expect(screen.getByTestId("setup-guide-tutorial")).toHaveTextContent(/新手教程|Tutorial/);
    // 聚焦卡展开并指向第一个未完成项（首次多开）
    expect(screen.getByText(/下一步|Next step/)).toBeVisible();
  });
});
