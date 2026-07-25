import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { skillService } from "@/services/skillService";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore, useOrchestratorStore, useWorkspacesStore } from "@/stores";
import HomeGettingStarted from "./HomeGettingStarted";

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
    useWorkspacesStore.setState({ workspaces: [] });
    useOrchestratorStore.setState({ bindings: [] });
  });

  it("渲染与核心工作流一致的五项清单", async () => {
    render(<HomeGettingStarted />);

    expect(screen.getByText("创建工作空间")).toBeVisible();
    expect(screen.getByText("导入第一个项目")).toBeVisible();
    expect(screen.getByText("完成首次多开")).toBeVisible();
    expect(screen.getByText("完成首次派工")).toBeVisible();
    expect(screen.getByText("安装第一个 Skill")).toBeVisible();
    expect(await screen.findByText("0 / 5 已完成")).toBeVisible();
  });

  it("创建工作空间步骤切到 panes 并展开 explorer 侧栏", async () => {
    render(<HomeGettingStarted />);
    await screen.findByText("0 / 5 已完成");

    fireEvent.click(screen.getByText("去创建"));

    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("explorer");
    expect(state.sidebarVisible).toBe(true);
  });

  it("导入项目步骤同样引导到 explorer 侧栏", async () => {
    render(<HomeGettingStarted />);
    await screen.findByText("0 / 5 已完成");

    fireEvent.click(screen.getByText("去导入"));

    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("explorer");
  });

  it("首次多开步骤打开黄金五分钟引导", async () => {
    render(<HomeGettingStarted />);
    await screen.findByText("0 / 5 已完成");

    fireEvent.click(screen.getByText("开始多开"));

    expect(useDialogStore.getState().onboardingOpen).toBe(true);
  });

  it("派工与 Skill 操作分别打开对应工作面", async () => {
    render(<HomeGettingStarted />);
    await screen.findByText("0 / 5 已完成");

    fireEvent.click(screen.getByText("打开编排"));
    expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(true);

    fireEvent.click(screen.getByText("浏览 Skills"));
    expect(useActivityBarStore.getState().appViewMode).toBe("resources");
  });
});
