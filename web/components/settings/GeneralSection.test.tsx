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

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ closeToTray: false }));

    await user.click(checkboxes[1]);
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

  it("emits language changes and lists CLI tools from the hook", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralSection value={createValue()} onChange={onChange} />);

    const selects = screen.getAllByRole("combobox");
    // 顺序：language → defaultCliTool → searchScope
    await user.selectOptions(selects[0], "en");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ language: "en" }));

    expect(screen.getByRole("option", { name: "Codex CLI" })).toBeInTheDocument();
    await user.selectOptions(selects[1], "codex");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ defaultCliTool: "codex" }));
  });

  it("shows a warning hint only when full-disk search is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<GeneralSection value={createValue()} onChange={onChange} />);

    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[2], "FullDisk");
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
});
