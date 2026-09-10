import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { open } from "@tauri-apps/plugin-dialog";
import { settingsService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { useDialogStore, useSettingsStore } from "@/stores";
import { useCliTools } from "@/hooks/useCliTools";
import type { DataDirInfo, GeneralSettings } from "@/types";
import GeneralSection from "./GeneralSection";

vi.mock("@/services/runtime", () => ({
  isTauriRuntime: vi.fn(() => true),
  isWebRuntime: vi.fn(() => false),
  invokeIfTauri: vi.fn(async () => undefined),
  listenIfTauri: vi.fn(async () => () => {}),
  listenWebviewIfTauri: vi.fn(async () => () => {}),
  getCurrentWindowIfTauri: vi.fn(() => null),
  logErrorSafe: vi.fn(),
  logInfoSafe: vi.fn(),
}));

vi.mock("@/services/settingsService", () => ({
  settingsService: {
    getDataDirInfo: vi.fn(),
    migrateDataDir: vi.fn(),
  },
}));

vi.mock("@/hooks/useCliTools", () => ({
  useCliTools: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

const dataDirInfo: DataDirInfo = {
  currentPath: "C:/Users/dev/.cc-panes",
  defaultPath: "C:/Users/dev/.cc-panes",
  isDefault: true,
  sizeBytes: 1024 * 1024,
};

function createValue(overrides: Partial<GeneralSettings> = {}): GeneralSettings {
  return {
    closeToTray: true,
    autoStart: false,
    language: "zh-CN",
    dataDir: null,
    searchScope: "Workspace",
    onboardingCompleted: true,
    defaultCliTool: "claude",
    launchFavorites: [],
    hideNonFavoriteLaunchActions: false,
    disableWslUsageScan: false,
    showSystemResources: true,
    trayShowSessionStatus: true,
    trayMaxPendingEntries: 5,
    trayTooltipSummary: true,
    trayConfirmQuit: true,
    ...overrides,
  };
}

const loadSettingsMock = vi.fn(async () => {});
const openOnboardingMock = vi.fn();

describe("GeneralSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(settingsService.getDataDirInfo).mockResolvedValue(dataDirInfo);
    vi.mocked(useCliTools).mockReturnValue({
      tools: [
        { id: "claude", displayName: "Claude Code", executable: "claude", installed: true } as never,
        { id: "codex", displayName: "Codex CLI", executable: "codex", installed: true } as never,
      ],
      loading: false,
      refresh: vi.fn(),
      getToolById: vi.fn(),
      installedTools: [],
    });
    useSettingsStore.setState({ loadSettings: loadSettingsMock });
    useDialogStore.setState({ openOnboarding: openOnboardingMock });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("toggles closeToTray and autoStart checkboxes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralSection value={createValue()} onChange={onChange} />);

    await user.click(
      screen.getByRole("checkbox", { name: /关闭窗口时最小化到托盘|Minimize to tray on close/i }),
    );
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ closeToTray: false }));

    await user.click(screen.getByRole("checkbox", { name: /开机自启|Start on boot/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ autoStart: true }));
  });

  it("toggles the global Local History watcher setting", async () => {
    const user = userEvent.setup();
    const onLocalHistoryEnabledChange = vi.fn();
    render(
      <GeneralSection
        value={createValue()}
        onChange={vi.fn()}
        localHistoryEnabled
        onLocalHistoryEnabledChange={onLocalHistoryEnabledChange}
      />,
    );

    await user.click(
      screen.getByRole("checkbox", {
        name: /启用 Local History 文件监听|Enable Local History file watching/i,
      }),
    );

    expect(onLocalHistoryEnabledChange).toHaveBeenCalledWith(false);
    expect(
      screen.getByText(/项目级设置不能覆盖此开关|Project settings cannot override it/i),
    ).toBeInTheDocument();
  });

  it("toggles the status bar system resource setting", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralSection value={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("checkbox", { name: /状态栏显示系统资源|Show system resources in the status bar/i }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ showSystemResources: false }));
  });

  it("toggles proactive update notifications", async () => {
    const user = userEvent.setup();
    const onUpdateNotifyEnabledChange = vi.fn();
    render(
      <GeneralSection
        value={createValue()}
        onChange={vi.fn()}
        updateNotifyEnabled
        onUpdateNotifyEnabledChange={onUpdateNotifyEnabledChange}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: /有新版本时提示|Notify me about new versions/i }));

    expect(onUpdateNotifyEnabledChange).toHaveBeenCalledWith(false);
  });

  it("toggles feature tips", async () => {
    const user = userEvent.setup();
    const onFeatureTipsEnabledChange = vi.fn();
    render(
      <GeneralSection
        value={createValue()}
        onChange={vi.fn()}
        featureTipsEnabled
        onFeatureTipsEnabledChange={onFeatureTipsEnabledChange}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: /功能提示|Feature tips/i }));

    expect(onFeatureTipsEnabledChange).toHaveBeenCalledWith(false);
  });

  it("emits language changes and lists CLI tools from the hook", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralSection value={createValue()} onChange={onChange} />);

    // 按 aria-label 定位，新增下拉（如托盘条数）不影响既有断言
    await user.click(screen.getByRole("combobox", { name: /^语言$|^Language$/i }));
    await user.click(screen.getByRole("option", { name: "English" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ language: "en" }));

    await user.click(screen.getByRole("combobox", { name: /默认 CLI 工具|Default CLI tool/i }));
    expect(screen.getByRole("option", { name: "Codex CLI" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Codex CLI" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultCliTool: "codex" }));
  });

  it("shows a warning hint only when full-disk search is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<GeneralSection value={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: /搜索范围|Search scope/i }));
    await user.click(screen.getByRole("option", { name: /全盘|Full disk/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ searchScope: "FullDisk" }));

    rerender(<GeneralSection value={createValue({ searchScope: "FullDisk" })} onChange={onChange} />);
    // FullDisk 提示文案以 accent 色渲染
    expect(document.querySelector('p[style*="--app-accent"]')).not.toBeNull();
  });

  it("loads and displays the data directory in desktop runtime", async () => {
    render(<GeneralSection value={createValue()} onChange={vi.fn()} />);

    expect(await screen.findByText("C:/Users/dev/.cc-panes")).toBeInTheDocument();
    expect(settingsService.getDataDirInfo).toHaveBeenCalled();
  });

  it("skips the data directory block outside the desktop runtime", () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    render(<GeneralSection value={createValue()} onChange={vi.fn()} />);

    expect(settingsService.getDataDirInfo).not.toHaveBeenCalled();
    expect(screen.queryByText("C:/Users/dev/.cc-panes")).not.toBeInTheDocument();
  });

  it("migrates the data directory after browsing and confirming", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    vi.mocked(open).mockResolvedValue("D:/new-data-dir");
    vi.mocked(settingsService.migrateDataDir).mockResolvedValue(undefined as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<GeneralSection value={createValue()} onChange={onChange} />);
    await screen.findByText("C:/Users/dev/.cc-panes");

    await user.click(screen.getByRole("button", { name: /浏览|Browse/i }));

    await waitFor(() =>
      expect(settingsService.migrateDataDir).toHaveBeenCalledWith("D:/new-data-dir"),
    );
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dataDir: "D:/new-data-dir" }));
    expect(loadSettingsMock).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it("does nothing when the migration confirm dialog is declined", async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue("D:/new-data-dir");
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<GeneralSection value={createValue()} onChange={vi.fn()} />);
    await screen.findByText("C:/Users/dev/.cc-panes");

    await user.click(screen.getByRole("button", { name: /浏览|Browse/i }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(settingsService.migrateDataDir).not.toHaveBeenCalled();
  });

  it("informs instead of migrating when the same directory is picked", async () => {
    const user = userEvent.setup();
    vi.mocked(open).mockResolvedValue(dataDirInfo.currentPath);
    render(<GeneralSection value={createValue()} onChange={vi.fn()} />);
    await screen.findByText("C:/Users/dev/.cc-panes");

    await user.click(screen.getByRole("button", { name: /浏览|Browse/i }));

    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(settingsService.migrateDataDir).not.toHaveBeenCalled();
  });

  it("offers a reset link when the data dir is customized and resets to default", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    vi.mocked(settingsService.getDataDirInfo).mockResolvedValue({
      ...dataDirInfo,
      currentPath: "D:/custom-dir",
      isDefault: false,
    });
    vi.mocked(settingsService.migrateDataDir).mockResolvedValue(undefined as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<GeneralSection value={createValue({ dataDir: "D:/custom-dir" })} onChange={onChange} />);
    await screen.findByText("D:/custom-dir");

    await user.click(screen.getByText(/恢复默认|Reset/i));

    await waitFor(() =>
      expect(settingsService.migrateDataDir).toHaveBeenCalledWith(dataDirInfo.defaultPath),
    );
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dataDir: null }));
  });

  it("restarts onboarding by resetting the flag and opening the dialog", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralSection value={createValue()} onChange={onChange} />);

    const buttons = screen.getAllByRole("button");
    await user.click(buttons[buttons.length - 1]);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ onboardingCompleted: false }));
    expect(openOnboardingMock).toHaveBeenCalled();
  });

  it("reset data dir action is a real focusable button with a focus-visible ring", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    vi.mocked(settingsService.getDataDirInfo).mockResolvedValue({
      ...dataDirInfo,
      currentPath: "D:/custom-dir",
      isDefault: false,
    });
    vi.mocked(settingsService.migrateDataDir).mockResolvedValue(undefined as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<GeneralSection value={createValue({ dataDir: "D:/custom-dir" })} onChange={onChange} />);
    await screen.findByText("D:/custom-dir");

    const resetButton = screen.getByRole("button", { name: /恢复默认|Reset/i });
    expect(resetButton.className).toContain("focus-visible:outline-none");
    expect(resetButton.className).toContain("focus-visible:ring-2");
    expect(resetButton.className).toContain("focus-visible:ring-[var(--app-accent)]");

    resetButton.focus();
    expect(resetButton).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(settingsService.migrateDataDir).toHaveBeenCalledWith(dataDirInfo.defaultPath),
    );
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dataDir: null }));
  });

  describe("系统托盘设置区", () => {
    it("renders the tray subsection with all four controls", () => {
      render(<GeneralSection value={createValue()} onChange={vi.fn()} />);

      expect(screen.getByText(/系统托盘|System Tray/i)).toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", { name: /托盘菜单显示会话状态|Show session status in tray menu/i }),
      ).toBeChecked();
      expect(
        screen.getByRole("combobox", { name: /待处理会话最多显示条数|Max pending sessions shown/i }),
      ).toHaveTextContent("5");
      expect(
        screen.getByRole("checkbox", { name: /托盘悬停提示显示状态摘要|Show status summary in tray tooltip/i }),
      ).toBeChecked();
      expect(
        screen.getByRole("checkbox", { name: /退出前确认|Confirm before quitting/i }),
      ).toBeChecked();
    });

    it("toggles trayShowSessionStatus / trayTooltipSummary / trayConfirmQuit", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<GeneralSection value={createValue()} onChange={onChange} />);

      await user.click(
        screen.getByRole("checkbox", { name: /托盘菜单显示会话状态|Show session status in tray menu/i }),
      );
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ trayShowSessionStatus: false }),
      );

      await user.click(
        screen.getByRole("checkbox", { name: /托盘悬停提示显示状态摘要|Show status summary in tray tooltip/i }),
      );
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ trayTooltipSummary: false }),
      );

      await user.click(
        screen.getByRole("checkbox", { name: /退出前确认|Confirm before quitting/i }),
      );
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ trayConfirmQuit: false }),
      );
    });

    it("changes trayMaxPendingEntries as a number within the 1-10 option range", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<GeneralSection value={createValue()} onChange={onChange} />);

      await user.click(
        screen.getByRole("combobox", { name: /待处理会话最多显示条数|Max pending sessions shown/i }),
      );
      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(10);
      await user.click(screen.getByRole("option", { name: "8" }));

      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ trayMaxPendingEntries: 8 }),
      );
    });

    it("falls back to defaults for legacy settings without tray fields", () => {
      const legacyValue: Record<string, unknown> = { ...createValue() };
      delete legacyValue.trayShowSessionStatus;
      delete legacyValue.trayMaxPendingEntries;
      delete legacyValue.trayTooltipSummary;
      delete legacyValue.trayConfirmQuit;

      render(<GeneralSection value={legacyValue as unknown as GeneralSettings} onChange={vi.fn()} />);

      expect(
        screen.getByRole("checkbox", { name: /托盘菜单显示会话状态|Show session status in tray menu/i }),
      ).toBeChecked();
      expect(
        screen.getByRole("combobox", { name: /待处理会话最多显示条数|Max pending sessions shown/i }),
      ).toHaveTextContent("5");
      expect(
        screen.getByRole("checkbox", { name: /托盘悬停提示显示状态摘要|Show status summary in tray tooltip/i }),
      ).toBeChecked();
      expect(
        screen.getByRole("checkbox", { name: /退出前确认|Confirm before quitting/i }),
      ).toBeChecked();
    });

    it("marks the tray subsection as the general-tray scroll target", () => {
      const { container } = render(<GeneralSection value={createValue()} onChange={vi.fn()} />);

      expect(
        container.querySelector('[data-settings-section="general-tray"]'),
      ).not.toBeNull();
    });
  });
});
