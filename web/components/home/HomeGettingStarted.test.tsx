import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores";
import HomeGettingStarted from "./HomeGettingStarted";

describe("HomeGettingStarted", () => {
  beforeEach(() => {
    useActivityBarStore.setState({
      activeView: "sessions",
      sidebarVisible: false,
      appViewMode: "home",
      orchestrationOverlayOpen: false,
    });
    useDialogStore.setState({ onboardingOpen: false });
  });

  it("渲染三个步骤与完整教程链接", () => {
    render(<HomeGettingStarted onNewTerminal={vi.fn()} />);

    expect(screen.getByText("创建工作空间")).toBeVisible();
    expect(screen.getByText("添加项目")).toBeVisible();
    expect(screen.getByText("启动第一个任务")).toBeVisible();
    expect(screen.getByText("查看完整入门教程")).toBeVisible();
  });

  it("创建工作空间步骤切到 panes 并展开 explorer 侧栏", () => {
    render(<HomeGettingStarted onNewTerminal={vi.fn()} />);

    fireEvent.click(screen.getByText("去创建"));

    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("explorer");
    expect(state.sidebarVisible).toBe(true);
  });

  it("添加项目步骤同样引导到 explorer 侧栏", () => {
    render(<HomeGettingStarted onNewTerminal={vi.fn()} />);

    fireEvent.click(screen.getByText("去添加"));

    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("explorer");
  });

  it("启动任务步骤回调 onNewTerminal", () => {
    const onNewTerminal = vi.fn();
    render(<HomeGettingStarted onNewTerminal={onNewTerminal} />);

    fireEvent.click(screen.getByText("打开终端"));

    expect(onNewTerminal).toHaveBeenCalledTimes(1);
  });

  it("完整教程链接打开 onboarding 对话框", () => {
    render(<HomeGettingStarted onNewTerminal={vi.fn()} />);

    fireEvent.click(screen.getByText("查看完整入门教程"));

    expect(useDialogStore.getState().onboardingOpen).toBe(true);
  });
});
