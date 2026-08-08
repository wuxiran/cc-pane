import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { skillService } from "@/services/skillService";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import {
  useDialogStore,
  useOrchestratorStore,
  useRightDockStore,
  useWorkspacesStore,
} from "@/stores";
import type { Workspace } from "@/types";
import HomeGettingStarted from "./HomeGettingStarted";

vi.mock("@/components/onboarding/AgentConciergeEntry", () => ({
  default: () => <div data-testid="concierge-entry" />,
}));

const workspace = {
  id: "workspace-1",
  name: "demo",
  projects: [{ id: "project-1", path: "/workspace/demo" }],
} as Workspace;

describe("HomeGettingStarted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.spyOn(skillService, "listUserSkills").mockResolvedValue([]);
    useActivityBarStore.setState({
      activeView: "sessions",
      sidebarVisible: false,
      appViewMode: "home",
      orchestrationOverlayOpen: false,
    });
    useDialogStore.setState({ onboardingOpen: false });
    useRightDockStore.setState({ visible: false, activeView: "git" });
    useWorkspacesStore.setState({ workspaces: [] });
    useOrchestratorStore.setState({ bindings: [] });
  });

  it("渲染与核心工作流一致的五节点旅程条", async () => {
    render(<HomeGettingStarted />);

    expect(screen.getByText("创建工作空间")).toBeVisible();
    expect(screen.getByText("导入第一个项目")).toBeVisible();
    expect(screen.getByText("完成首次多开")).toBeVisible();
    expect(screen.getByText("完成首次派工")).toBeVisible();
    expect(screen.getByText("试 Skill")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0"),
    );
  });

  it("初始态主 CTA 打开新手教程（五步向导）", async () => {
    render(<HomeGettingStarted />);
    await waitFor(() =>
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0"),
    );

    fireEvent.click(screen.getByTestId("setup-guide-tutorial"));

    expect(useDialogStore.getState().onboardingOpen).toBe(true);
  });

  it("有进度后聚焦卡的行动按钮打开五步向导（首次多开）", async () => {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    render(<HomeGettingStarted />);
    await waitFor(() =>
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2"),
    );

    fireEvent.click(screen.getByText("开始多开"));

    expect(useDialogStore.getState().onboardingOpen).toBe(true);
  });

  it("派工步骤的行动按钮打开右坞编排面", async () => {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    localStorage.setItem("cc-panes-onboarding-multi-launch", "true");
    render(<HomeGettingStarted />);
    await waitFor(() =>
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3"),
    );

    fireEvent.click(screen.getByText("打开编排"));

    expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(false);
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "orchestration",
    });
  });
});
