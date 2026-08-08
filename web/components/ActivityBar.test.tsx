import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ActivityBar from "./ActivityBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import {
  createDefaultModulePreferences,
  useModulePrefsStore,
} from "@/stores/useModulePrefsStore";
import { useDialogStore, useOrchestratorStore } from "@/stores";
import type { TaskBinding } from "@/types";
import { useAiPanelStore } from "@/stores/useAiPanelStore";

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
  useModulePrefsStore.setState({ preferences: createDefaultModulePreferences() });
  useAiPanelStore.setState({ panels: [], activePanelId: null, unreadPanelIds: [] });
}

describe("ActivityBar", () => {
  beforeEach(() => {
    resetStores();
  });

  it("渲染主视图图标集合（含 Home 与 设置）以及 LayoutBar 桩", () => {
    const { container } = renderBar();
    expect(screen.getByTestId("layout-bar-stub")).toBeInTheDocument();
    // Home + explorer/ssh + todo + settings = 5 按钮
    //（files 与 sessions 图标已移除：Explorer 侧栏自带 文件 / 最近启动 tab）
    expect(container.querySelectorAll("button")).toHaveLength(5);
  });

  it("不再有 sessions 竖排入口：explorer 之后紧跟 ssh（最近启动已迁至 Explorer 顶部 tab）", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    // 索引 2 原为 sessions，现应为 ssh
    await user.click(container.querySelectorAll("button")[2]);
    expect(useActivityBarStore.getState().activeView).toBe("ssh");
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

  it("点击 Todo 图标进入视图，再次点击折叠任务侧栏", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    const buttons = container.querySelectorAll("button");
    const todoBtn = buttons[buttons.length - 2];
    await user.click(todoBtn);
    expect(useActivityBarStore.getState().appViewMode).toBe("todo");
    expect(useActivityBarStore.getState().sidebarVisible).toBe(true);

    await user.click(todoBtn);
    expect(useActivityBarStore.getState().appViewMode).toBe("todo");
    expect(useActivityBarStore.getState().sidebarVisible).toBe(false);
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

  it("keeps orchestration out of the activity bar even with running tasks", () => {
    useModulePrefsStore.getState().setPosition("orchestration", "activityBar");
    useOrchestratorStore.setState({
      bindings: [binding("running"), binding("waiting")],
    });
    const { container } = renderBar();
    expect(container.querySelector('[data-module-id="orchestration"]')).not.toBeInTheDocument();
  });

  it("只渲染启用且位于左栏的注册模块", () => {
    useModulePrefsStore.getState().setPosition("ssh", "rightDock");
    useModulePrefsStore.getState().setPosition("todo", "hidden");
    useModulePrefsStore.getState().setEnabled("orchestration", false);

    const { container } = renderBar();

    expect(container.querySelector('[data-module-id="ssh"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-module-id="orchestration"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-module-id="todo"]')).not.toBeInTheDocument();
  });

  it("在左栏空白处打开模块菜单并把模块移到右坞", async () => {
    const user = userEvent.setup();
    renderBar();

    fireEvent.contextMenu(screen.getByTestId("activity-bar"), {
      clientX: 20,
      clientY: 120,
    });
    const todoMenu = await screen.findByTestId("module-menu-todo");
    act(() => todoMenu.focus());
    await user.keyboard("[ArrowRight]");
    const rightDockItem = await screen.findByTestId("module-position-todo-rightDock");
    act(() => rightDockItem.focus());
    await user.keyboard("[Enter]");

    expect(useModulePrefsStore.getState().preferences.todo).toEqual({
      enabled: true,
      position: "rightDock",
    });
  });

  it("Home 处于激活态时按钮带激活背景样式与左缘 accent 竖条", () => {
    useActivityBarStore.setState({ appViewMode: "home" });
    const { container } = renderBar();
    const homeBtn = container.querySelectorAll("button")[0] as HTMLElement;
    const explorerBtn = container.querySelectorAll("button")[1] as HTMLElement;
    expect(homeBtn.style.background).toContain("app-activity-item-active");
    // demo 式激活指示条：激活项左缘 3px accent 竖条
    const indicator = homeBtn.parentElement?.querySelector('span[aria-hidden]');
    expect(indicator).not.toBeNull();
    expect(explorerBtn.style.background).toBe("");
    expect(explorerBtn.parentElement?.querySelector('span[aria-hidden]')).toBeNull();
  });
});
