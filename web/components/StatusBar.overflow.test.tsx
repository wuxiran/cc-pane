import "@/i18n";
import i18n from "@/i18n";
import { act, render, screen } from "@testing-library/react";
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
import { createTestSettings } from "@/test/utils/testData";
import { mockTauriInvoke } from "@/test/utils/mockTauriInvoke";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));

vi.mock("@/components/statusbar/SystemResourceSegment", () => ({
  default: () => <span data-testid="system-resource-segment">system resources</span>,
}));

function setWidth(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event("resize"));
  });
}

function renderSB() {
  return render(
    <TooltipProvider>
      <StatusBar />
    </TooltipProvider>,
  );
}

const MORE_LABEL = "更多工具";
const LANG_LABEL = "切换语言";

describe("StatusBar 窄档溢出", () => {
  beforeEach(() => {
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
    useSettingsStore.setState({ settings: createTestSettings() });
  });

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
    const { container } = renderSB();

    // 行内保留：命令面板、通知铃铛、主题菜单；语言等收进菜单（未打开时不挂载）
    expect(screen.getByRole("button", { name: MORE_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: LANG_LABEL })).toBeNull();
    expect(container.querySelector("svg.lucide-bell")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: MORE_LABEL }));
    expect(screen.getByRole("button", { name: LANG_LABEL })).toBeInTheDocument();
  });

  it("根容器带 tabular-nums：动态数字等宽不跳动（继承到子代数字）", () => {
    setWidth(1280);
    const { container } = renderSB();
    expect(container.firstElementChild).toHaveClass("tabular-nums");
  });

  it("xs（<640）：通知铃铛也收进更多菜单", async () => {
    const user = userEvent.setup();
    setWidth(500);
    const { container } = renderSB();
    expect(container.querySelector("svg.lucide-bell")).toBeNull();

    await user.click(screen.getByRole("button", { name: MORE_LABEL }));
    expect(document.querySelector("svg.lucide-bell")).not.toBeNull();
  });
});
