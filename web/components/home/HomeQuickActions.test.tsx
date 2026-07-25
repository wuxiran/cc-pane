import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores";
import HomeQuickActions from "./HomeQuickActions";

vi.mock("@/components/onboarding/AgentConciergeEntry", () => ({
  default: () => <button type="button">对 agent 说</button>,
}));

describe("HomeQuickActions", () => {
  beforeEach(() => {
    useActivityBarStore.setState({
      activeView: "sessions",
      sidebarVisible: false,
      appViewMode: "home",
      orchestrationOverlayOpen: false,
    });
    useDialogStore.setState({ settingsOpen: false });
  });

  it("渲染常用操作与常驻 agent 入口", () => {
    render(<HomeQuickActions onNewTerminal={vi.fn()} onOpenTerminal={vi.fn()} />);

    expect(screen.getByText("新建终端")).toBeVisible();
    expect(screen.getByText("工作空间管理")).toBeVisible();
    expect(screen.getByText("设置")).toBeVisible();
    expect(screen.getByText("对 agent 说")).toBeVisible();
  });

  it("点击新建终端回调 onNewTerminal", () => {
    const onNewTerminal = vi.fn();
    render(<HomeQuickActions onNewTerminal={onNewTerminal} onOpenTerminal={vi.fn()} />);

    fireEvent.click(screen.getByText("新建终端"));

    expect(onNewTerminal).toHaveBeenCalledTimes(1);
  });

  it("点击工作空间管理切换到 panes 模式并展开 explorer 侧栏", () => {
    render(<HomeQuickActions onNewTerminal={vi.fn()} onOpenTerminal={vi.fn()} />);

    fireEvent.click(screen.getByText("工作空间管理"));

    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("explorer");
    expect(state.sidebarVisible).toBe(true);
  });

  it("点击设置打开设置对话框", () => {
    render(<HomeQuickActions onNewTerminal={vi.fn()} onOpenTerminal={vi.fn()} />);

    fireEvent.click(screen.getByText("设置"));

    expect(useDialogStore.getState().settingsOpen).toBe(true);
  });
});
