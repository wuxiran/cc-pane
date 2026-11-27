import "@/i18n";
import i18n from "@/i18n";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StatusBar from "./StatusBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useThemeStore,
  useWorkspacesStore,
  useTerminalStatusStore,
  useUpdateStore,
  useSettingsStore,
} from "@/stores";
import { useCCChanStore, DEFAULT_CCCHAN_SETTINGS } from "@/stores/useCCChanStore";
import { createTestWorkspace, createTestSettings } from "@/test/utils/testData";
import { mockTauriInvoke } from "@/test/utils/mockTauriInvoke";
import type { TerminalStatusInfo } from "@/types";

// useWindowControl 会在挂载时访问当前窗口
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));

vi.mock("@/components/statusbar/SystemResourceSegment", () => ({
  default: () => <span data-testid="system-resource-segment">system resources</span>,
}));

// triggerUpdate 走真实 updater 流程，这里桩掉，保留其余 services 真实导出
const { triggerUpdateMock } = vi.hoisted(() => ({ triggerUpdateMock: vi.fn(() => Promise.resolve()) }));
vi.mock("@/services", async (importActual) => {
  const actual = await importActual<typeof import("@/services")>();
  return { ...actual, triggerUpdate: triggerUpdateMock };
});

function renderSB(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <StatusBar />
    </TooltipProvider>,
  );
}

function makeStatus(status: TerminalStatusInfo["status"]): TerminalStatusInfo {
  return {
    sessionId: "s1",
    status,
    lastOutputAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function resetStores() {
  vi.clearAllMocks();
  mockTauriInvoke({
    get_ccchan_settings: null,
    get_ccchan_pets: null,
    update_settings: null,
    show_ccchan: null,
    hide_ccchan: null,
    toggle_always_on_top: true,
  });
  i18n.changeLanguage("zh-CN");
  useThemeStore.setState({ isDark: false });
  useWorkspacesStore.setState({ workspaces: [], expandedWorkspaceId: null });
  useTerminalStatusStore.setState({ statusMap: new Map() });
  useUpdateStore.setState({ available: false, version: null, body: null });
  useCCChanStore.setState({ settings: { ...DEFAULT_CCCHAN_SETTINGS, windowVisible: false } });
  useSettingsStore.setState({ settings: createTestSettings({ general: { ...createTestSettings().general, language: "zh-CN" } }) });
}

const t = i18n.t as (key: string, options?: Record<string, unknown>) => string;

describe("StatusBar", () => {
  beforeEach(resetStores);

  it("显示当前工作空间别名", () => {
    const ws = createTestWorkspace({ name: "my-ws", alias: "别名工作区" });
    useWorkspacesStore.setState({ workspaces: [ws], expandedWorkspaceId: ws.id });
    renderSB();
    expect(screen.getByText("别名工作区")).toBeInTheDocument();
  });

  it("存在忙碌会话时显示活跃终端计数", () => {
    useTerminalStatusStore.setState({ statusMap: new Map([["s1", makeStatus("thinking")]]) });
    renderSB();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("无忙碌会话时不显示活跃计数", () => {
    useTerminalStatusStore.setState({ statusMap: new Map([["s1", makeStatus("idle")]]) });
    renderSB();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("按通用设置开关挂载或隐藏系统资源段", async () => {
    const settings = createTestSettings();
    useSettingsStore.setState({
      settings: {
        ...settings,
        general: { ...settings.general, showSystemResources: false },
      },
    });
    renderSB();
    expect(screen.queryByTestId("system-resource-segment")).not.toBeInTheDocument();

    act(() => {
      useSettingsStore.setState({
        settings: {
          ...settings,
          general: { ...settings.general, showSystemResources: true },
        },
      });
    });
    expect(screen.getByTestId("system-resource-segment")).toBeInTheDocument();
  });

  it("状态栏不再提供窗口置顶与迷你模式入口（置顶已移到标题栏右上角）", () => {
    renderSB();
    expect(screen.queryByRole("button", { name: "窗口置顶" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "迷你模式" })).not.toBeInTheDocument();
  });

  it("切换语言时更新 i18n 并持久化到设置", async () => {
    const user = userEvent.setup();
    renderSB();

    // 语言按钮新增 aria-label 后 accessible name 来自 i18n（原为可见文本「中」），断言语义不变
    await user.click(screen.getByRole("button", { name: "切换语言" }));

    await waitFor(() => expect(i18n.language).toBe("en"));
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.general.language).toBe("en"),
    );
  });

  it("通过主题菜单切换预设并保存设置", async () => {
    const user = userEvent.setup();
    renderSB();

    await user.click(screen.getByRole("button", { name: "选择配色主题" }));
    await user.click(screen.getByRole("menuitem", { name: /夜泊蓝/ }));

    await waitFor(() => expect(useThemeStore.getState().isDark).toBe(true));
    expect(useThemeStore.getState().themeId).toBe("tokyo-night");
    expect(useSettingsStore.getState().settings?.theme.mode).toBe("tokyo-night");
  });

  it("切换 cc酱 浮窗调用 IPC 并更新可见状态", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const user = userEvent.setup();
    renderSB();

    await user.click(screen.getByRole("button", { name: t("statusbar.ccchanShow") }));

    await waitFor(() =>
      expect(useCCChanStore.getState().settings.windowVisible).toBe(true),
    );
    expect(invoke).toHaveBeenCalledWith("show_ccchan");
    expect(screen.getByRole("button", { name: t("statusbar.ccchanHide") })).toBeInTheDocument();
  });

  it("有可用更新时显示版本按钮并触发更新", async () => {
    const user = userEvent.setup();
    useUpdateStore.setState({ available: true, version: "9.9.9", body: null });
    renderSB();

    const updateBtn = screen.getByRole("button", { name: /v9\.9\.9/ });
    await user.click(updateBtn);

    expect(triggerUpdateMock).toHaveBeenCalledTimes(1);
  });
});

describe("StatusBar 窄档溢出", () => {
  const MORE_LABEL = "更多工具";
  const LANG_LABEL = "切换语言";
  const bell = () => screen.queryByRole("button", { name: t("center.bellTooltip", { ns: "notifications" }) });
  const setWidth = (width: number) => {
    act(() => {
      window.innerWidth = width;
      window.dispatchEvent(new Event("resize"));
    });
  };

  beforeEach(resetStores);
  afterEach(() => setWidth(1024));

  it("宽档（>=1024）：无更多菜单，语言按钮行内可见", () => {
    setWidth(1280);
    renderSB();
    expect(screen.queryByRole("button", { name: MORE_LABEL })).toBeNull();
    expect(screen.getByRole("button", { name: LANG_LABEL })).toBeInTheDocument();
  });

  it("窄档（<1024）：低优先级项收进更多菜单，铃铛仍行内", async () => {
    const user = userEvent.setup();
    setWidth(800);
    renderSB();

    // 行内保留：命令面板、通知铃铛、主题菜单；语言等收进菜单（未打开时不挂载）
    expect(screen.queryByRole("button", { name: LANG_LABEL })).toBeNull();
    expect(bell()).not.toBeNull();

    await user.click(screen.getByRole("button", { name: MORE_LABEL }));
    expect(screen.getByRole("button", { name: LANG_LABEL })).toBeInTheDocument();
  });

  it("xs（<640）：通知铃铛也收进更多菜单", async () => {
    const user = userEvent.setup();
    setWidth(500);
    renderSB();
    expect(bell()).toBeNull();

    await user.click(screen.getByRole("button", { name: MORE_LABEL }));
    expect(bell()).not.toBeNull();
  });
});
