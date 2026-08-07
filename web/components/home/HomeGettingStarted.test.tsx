import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import {
  useDialogStore,
  useOrchestratorStore,
  useRightDockStore,
  useWorkspacesStore,
} from "@/stores";
import HomeGettingStarted from "./HomeGettingStarted";

describe("HomeGettingStarted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
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

  it("渲染与核心工作流一致的四项清单", async () => {
    render(<HomeGettingStarted />);

    expect(screen.getByText("创建工作空间")).toBeVisible();
    expect(screen.getByText("导入第一个项目")).toBeVisible();
    expect(screen.getByText("完成首次多开")).toBeVisible();
    expect(screen.getByText("完成首次派工")).toBeVisible();
    expect(await screen.findByText("0 / 4 已完成")).toBeVisible();
  });

  it("创建工作空间步骤切到 panes 并展开 explorer 侧栏", async () => {
    render(<HomeGettingStarted />);
    await screen.findByText("0 / 4 已完成");

    fireEvent.click(screen.getByText("去创建"));

    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("explorer");
    expect(state.sidebarVisible).toBe(true);
  });

  it("导入项目步骤同样引导到 explorer 侧栏", async () => {
    render(<HomeGettingStarted />);
    await screen.findByText("0 / 4 已完成");

    fireEvent.click(screen.getByText("去导入"));

    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("explorer");
  });

  it("首次多开步骤打开黄金五分钟引导", async () => {
    render(<HomeGettingStarted />);
    await screen.findByText("0 / 4 已完成");

    fireEvent.click(screen.getByText("开始多开"));

    expect(useDialogStore.getState().onboardingOpen).toBe(true);
  });

  it("派工操作打开对应工作面", async () => {
    render(<HomeGettingStarted />);
    await screen.findByText("0 / 4 已完成");

    fireEvent.click(screen.getByText("打开编排"));
    expect(useActivityBarStore.getState().orchestrationOverlayOpen).toBe(false);
    expect(useRightDockStore.getState()).toMatchObject({
      visible: true,
      activeView: "orchestration",
    });
  });
});
