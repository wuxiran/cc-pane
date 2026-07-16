import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ActivityBar from "./ActivityBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore, useOrchestratorStore } from "@/stores";
import type { TaskBinding } from "@/types";

// jsdom 缺少 ResizeObserver，Radix Tooltip 依赖它（否则 hover 交互抛错中断 userEvent）
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

// LayoutBar 有自己的 dnd/portal/toast 复杂逻辑，与 ActivityBar 无关，桩掉隔离测试
vi.mock("@/components/LayoutBar", () => ({
  default: () => <div data-testid="layout-bar-stub" />,
}));

function binding(status: TaskBinding["status"]): TaskBinding {
  return { status } as unknown as TaskBinding;
}

function renderBar() {
  return render(
    <TooltipProvider>
      <ActivityBar />
    </TooltipProvider>,
  );
}

function resetStores() {
  useActivityBarStore.setState({
    activeView: "explorer",
    sidebarVisible: true,
    appViewMode: "home",
    orchestrationOverlayOpen: false,
  });
  useDialogStore.setState({ settingsOpen: false });
  useOrchestratorStore.setState({ bindings: [] });
}

describe("ActivityBar", () => {
  beforeEach(() => {
    resetStores();
  });

  it("渲染主视图图标集合（含 Home 与 设置）以及 LayoutBar 桩", () => {
    const { container } = renderBar();
    expect(screen.getByTestId("layout-bar-stub")).toBeInTheDocument();
    // Home + explorer/files/sessions/ssh/orchestration + 资源中心 + todo + settings = 9 按钮
    expect(container.querySelectorAll("button")).toHaveLength(9);
  });

  it("点击 Home 图标在 home 与 panes 之间切换", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    const homeBtn = container.querySelectorAll("button")[0];

    // 初始 home
    expect(useActivityBarStore.getState().appViewMode).toBe("home");
    await user.click(homeBtn);
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
    await user.click(homeBtn);
    expect(useActivityBarStore.getState().appViewMode).toBe("home");
  });

  it("点击资源中心图标切换到 resources 视图模式", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    // 资源中心是倒数第三个（todo、settings 之前）
    const buttons = container.querySelectorAll("button");
    const resourcesBtn = buttons[buttons.length - 3];
    await user.click(resourcesBtn);
    expect(useActivityBarStore.getState().appViewMode).toBe("resources");
  });

  it("点击 Todo 图标切换到 todo 视图模式", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    const buttons = container.querySelectorAll("button");
    const todoBtn = buttons[buttons.length - 2];
    await user.click(todoBtn);
    expect(useActivityBarStore.getState().appViewMode).toBe("todo");
  });

  it("点击底部设置按钮打开设置对话框", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    const buttons = container.querySelectorAll("button");
    const settingsBtn = buttons[buttons.length - 1];
    await user.click(settingsBtn);
    expect(useDialogStore.getState().settingsOpen).toBe(true);
  });

  it("点击 explorer 视图从 home 退回 panes 并激活该视图", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    // 索引 1 = explorer
    const explorerBtn = container.querySelectorAll("button")[1];
    await user.click(explorerBtn);
    const state = useActivityBarStore.getState();
    expect(state.appViewMode).toBe("panes");
    expect(state.activeView).toBe("explorer");
  });

  it("有运行中的编排任务时 orchestration 图标显示数量徽标", () => {
    useOrchestratorStore.setState({
      bindings: [binding("running"), binding("waiting")],
    });
    renderBar();
    // 2 个 running/waiting → 徽标数字 2
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("Home 处于激活态时按钮带激活背景样式与左缘 accent 竖条", () => {
    useActivityBarStore.setState({ appViewMode: "home" });
    const { container } = renderBar();
    const homeBtn = container.querySelectorAll("button")[0] as HTMLElement;
    expect(homeBtn.style.background).toContain("app-activity-item-active");
    // demo 式激活指示条：激活项左缘 3px accent 竖条
    const indicator = homeBtn.parentElement?.querySelector('[aria-hidden]');
    expect(indicator).not.toBeNull();
  });
});
