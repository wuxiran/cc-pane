import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ActivityBar from "./ActivityBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import {
  createDefaultModulePreferences,
  useModulePrefsStore,
} from "@/stores/useModulePrefsStore";
import { useDialogStore, useOrchestratorStore } from "@/stores";
import type { ExperimentalSettings, TaskBinding } from "@/types";
import { useAiPanelStore } from "@/stores/useAiPanelStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useUpdateStore } from "@/stores/useUpdateStore";

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

// 升级入口复用 updaterService.triggerUpdate（原生确认 + 下载安装 + 重启），测试里只断言调用与进行态
const { triggerUpdateMock } = vi.hoisted(() => ({ triggerUpdateMock: vi.fn<() => Promise<void>>() }));
vi.mock("@/services/updaterService", () => ({ triggerUpdate: triggerUpdateMock }));

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

/** 实验功能开关：媒体生成 / Skill 市场都是实验项。Release 默认全关、入口不出现；
 * vitest 下 import.meta.env.DEV 为 true（同 dev 实例默认全开），所以这里显式给基线。 */
function setExperimental(flags: Partial<ExperimentalSettings>) {
  const defaults = useSettingsStore.getState().getDefaults();
  useSettingsStore.setState({
    settings: {
      ...defaults,
      experimental: { dramaStudio: false, skillMarket: false, librarySpace: false, ...flags },
    },
  });
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
  useUpdateStore.getState().clearUpdate();
  setExperimental({});
}

describe("ActivityBar", () => {
  beforeEach(() => {
    resetStores();
  });

  it("实验功能全关（release 默认）时只有常驻入口", () => {
    const { container } = renderBar();
    expect(screen.getByTestId("layout-bar-stub")).toBeInTheDocument();
    // Home + explorer + providers + resources + 设备(ssh)/todo + 添加模块 + settings（SSH 机器与设备已合并为一个入口）
    //（files 与 sessions 图标已移除；通讯录从资源管理器标题旁移到这里，多一个常驻入口；供应商独立入口在工作空间下方）
    expect(container.querySelectorAll("button")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: /联系人|通讯录|Contacts/ }));
    expect(useActivityBarStore.getState().activeView).toBe("contacts");
    expect(container.querySelector('[data-module-id="devices"]')).toBeNull();
    expect(screen.getByRole("button", { name: "设备" })).toBeInTheDocument();
    // 技能市场已并入资源库，活动栏不再有单独入口
    expect(screen.queryByRole("button", { name: "技能市场" })).not.toBeInTheDocument();
  });

  it("实验功能未勾选时，store 动作也不能进入对应全屏页", () => {
    useActivityBarStore.getState().toggleDramaGenMode();
    expect(useActivityBarStore.getState().appViewMode).toBe("home");
    useActivityBarStore.getState().setAppViewMode("dramaGen");
    expect(useActivityBarStore.getState().appViewMode).toBe("home");
    // 非门禁模式照常
    useActivityBarStore.getState().setAppViewMode("panes");
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
  });

  it("勾选资料空间后出现入口，尚未创建时点击弹出创建框", async () => {
    setExperimental({ librarySpace: true });
    const user = userEvent.setup();
    const { container } = renderBar();
    expect(container.querySelectorAll("button")).toHaveLength(11);
    await user.click(screen.getByRole("button", { name: "创建资料空间" }));
    expect(await screen.findByRole("button", { name: "创建并打开素材助手" })).toBeInTheDocument();
  });

  it("不再有 sessions 竖排入口：explorer 之后紧跟 ssh（最近启动已迁至 Explorer 顶部 tab）", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    const sshButton = container.querySelector('[data-module-id="ssh"] button');
    expect(sshButton).not.toBeNull();
    await user.click(sshButton!);
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
    // 底部固定三枚：添加模块、自动化、设置；todo 是模块区最后一枚
    const todoBtn = buttons[buttons.length - 4];
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

  it("工作空间下方的供应商入口在 providers 与 panes 之间切换", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    // 索引 2 = providers（紧跟 explorer）
    const providersBtn = container.querySelectorAll("button")[2];
    await user.click(providersBtn);
    expect(useActivityBarStore.getState().appViewMode).toBe("providers");
    await user.click(providersBtn);
    expect(useActivityBarStore.getState().appViewMode).toBe("panes");
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

  it("经底部「添加模块」把会话历史放上左栏后即渲染出该图标", async () => {
    const user = userEvent.setup();
    const { container } = renderBar();

    expect(container.querySelector('[data-module-id="sessionHistory"]')).not.toBeInTheDocument();

    await user.click(screen.getByTestId("module-add-trigger"));
    await user.click(await screen.findByTestId("module-add-sessionHistory"));

    expect(container.querySelector('[data-module-id="sessionHistory"]')).toBeInTheDocument();
  });

  it("Home 处于激活态时按钮带激活背景样式与左缘 accent 竖条", () => {
    useActivityBarStore.setState({ appViewMode: "home" });
    const { container } = renderBar();
    const homeBtn = container.querySelectorAll("button")[0] as HTMLElement;
    const explorerBtn = container.querySelectorAll("button")[1] as HTMLElement;
    // 选中态是中性浅底 + 主文字色（实心图标上不用强调色）
    expect(homeBtn.className).toContain("text-[var(--app-text-primary)]");
    expect(homeBtn.className).toContain("bg-[color-mix(");
    // demo 式激活指示条：激活项左缘 3px accent 竖条
    const indicator = homeBtn.parentElement?.querySelector('span[aria-hidden]');
    expect(indicator).not.toBeNull();
    expect(explorerBtn.className).not.toContain(" bg-[color-mix(");
    expect(explorerBtn.parentElement?.querySelector('span[aria-hidden]')).toBeNull();
  });
});

describe("ActivityBar 升级入口", () => {
  beforeEach(() => {
    resetStores();
    triggerUpdateMock.mockReset();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("没有可用更新时不渲染", () => {
    renderBar();
    expect(screen.queryByTestId("activity-bar-update")).not.toBeInTheDocument();
  });

  it("非桌面运行时即使 store 有更新也不渲染（triggerUpdate 在 web 下是 no-op）", () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    useUpdateStore.getState().setUpdate("9.9.9", null);
    renderBar();
    expect(screen.queryByTestId("activity-bar-update")).not.toBeInTheDocument();
  });

  it("有更新时出现在底部组最上方，标签带新版本号与强调圆点", () => {
    useUpdateStore.getState().setUpdate("9.9.9", "changelog");
    renderBar();
    const button = screen.getByRole("button", { name: "发现新版本 v9.9.9，点击升级" });
    expect(button).toHaveAttribute("data-testid", "activity-bar-update");
    expect(screen.getByTestId("activity-bar-update-dot")).toBeInTheDocument();
    // 底部组：升级按钮排在「添加模块」之前（layoutSwitcherMode 非 corner 时 LayoutBar 不在底部组）
    const bottomGroup = button.closest("div.mt-auto") as HTMLElement;
    const buttons = Array.from(bottomGroup.querySelectorAll("button"));
    expect(buttons[0]).toBe(button);
  });

  it("点击触发 triggerUpdate，进行中禁用防重复点击，结束后恢复", async () => {
    let resolveUpdate: () => void = () => {};
    triggerUpdateMock.mockImplementation(
      () => new Promise<void>((resolve) => { resolveUpdate = resolve; }),
    );
    useUpdateStore.getState().setUpdate("9.9.9", null);
    renderBar();
    const button = screen.getByTestId("activity-bar-update");

    fireEvent.click(button);
    fireEvent.click(button);
    expect(triggerUpdateMock).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAccessibleName("正在升级到 v9.9.9…");
    expect(screen.queryByTestId("activity-bar-update-dot")).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(triggerUpdateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUpdate();
    });
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).toHaveAccessibleName("发现新版本 v9.9.9，点击升级");
  });

  it("triggerUpdate 抛错后同样解除进行态，可再次点击", async () => {
    triggerUpdateMock.mockRejectedValueOnce(new Error("boom"));
    useUpdateStore.getState().setUpdate("9.9.9", null);
    renderBar();
    const button = screen.getByTestId("activity-bar-update");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button).not.toHaveAttribute("aria-disabled");
    triggerUpdateMock.mockResolvedValueOnce();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(triggerUpdateMock).toHaveBeenCalledTimes(2);
  });
});
