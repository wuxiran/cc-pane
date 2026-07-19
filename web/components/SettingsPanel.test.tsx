import "@/i18n";
import i18n from "i18next";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { AppSettings } from "@/types";
import { useSettingsStore } from "@/stores";
import { DEFAULT_CCCHAN_SETTINGS, useCCChanStore } from "@/stores/useCCChanStore";
import SettingsPanel from "./SettingsPanel";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

interface SectionProps<T> {
  value: T;
  onChange: (value: T) => void;
}

let generalSectionProps: SectionProps<AppSettings["general"]> | null = null;

vi.mock("./settings/GeneralSection", () => ({
  default: (props: SectionProps<AppSettings["general"]>) => {
    generalSectionProps = props;
    return <div data-testid="general-section" />;
  },
}));
vi.mock("./settings/NotificationSection", () => ({
  default: () => <div data-testid="notification-section" />,
}));
vi.mock("./settings/ProviderSection", () => ({
  default: () => <div data-testid="provider-section" />,
}));
vi.mock("./settings/ProxySection", () => ({
  default: () => <div data-testid="proxy-section" />,
}));
vi.mock("./settings/TerminalSection", () => ({
  default: () => <div data-testid="terminal-section" />,
}));
vi.mock("./settings/CliLaunchersSection", () => ({
  default: () => <div data-testid="cli-launchers-section" />,
}));
vi.mock("./settings/ShortcutsSection", () => ({
  default: () => <div data-testid="shortcuts-section" />,
}));
vi.mock("./settings/AboutSection", () => ({
  default: () => <div data-testid="about-section" />,
}));
vi.mock("./settings/ScreenshotSection", () => ({
  default: () => <div data-testid="screenshot-section" />,
}));
vi.mock("./settings/SharedMcpSection", () => ({
  default: () => <div data-testid="shared-mcp-section" />,
}));
vi.mock("./settings/VoiceSection", () => ({
  default: () => <div data-testid="voice-section" />,
}));
vi.mock("./settings/WebAccessSection", () => ({
  default: () => <div data-testid="web-access-section" />,
}));
vi.mock("./settings/CCChanSettings", () => ({
  default: () => <div data-testid="ccchan-section" />,
}));

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

function makeSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    general: { language: "zh-CN", defaultCliTool: "claude" },
    notification: {},
    webAccess: { passwordSalt: "salt-live", passwordHash: "hash-live" },
    cliLaunchers: {},
    proxy: {},
    terminal: {},
    voice: {},
    shortcuts: {},
    screenshot: {},
    ...overrides,
  } as unknown as AppSettings;
}

const tRaw = i18n.t as (key: string, options?: Record<string, unknown>) => string;
function tSettings(key: string) {
  return tRaw(key, { ns: "settings" });
}

describe("SettingsPanel", () => {
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const saveCCChanSettings = vi.fn().mockResolvedValue(undefined);
  const getDefaults = vi.fn(() => makeSettings({
    webAccess: { passwordSalt: "salt-default", passwordHash: "hash-default" } as never,
  }));

  beforeEach(() => {
    useSettingsStore.setState({
      settings: makeSettings(),
      saveSettings,
      getDefaults,
    } as never);
    useCCChanStore.setState({ saveSettings: saveCCChanSettings } as never);
  });

  afterEach(() => {
    generalSectionProps = null;
    vi.clearAllMocks();
  });

  it("opens on the general section with the settings dialog title", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    expect(screen.getByText(tSettings("title"))).toBeInTheDocument();
    expect(screen.getByTestId("general-section")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-section")).not.toBeInTheDocument();
  });

  it("syncs the draft from the stored settings when opened", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    expect(generalSectionProps?.value).toEqual(makeSettings().general);
  });

  it("switches sections via the left navigation", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("terminal") }));
    expect(screen.getByTestId("terminal-section")).toBeInTheDocument();
    expect(screen.queryByTestId("general-section")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Shared MCP" }));
    expect(screen.getByTestId("shared-mcp-section")).toBeInTheDocument();
  });

  it("shows the screenshot section on non-mac platforms", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: tSettings("screenshot") })).toBeInTheDocument();
  });

  it("auto-saves edits after debounce, preserving live web-access credentials", async () => {
    const onOpenChange = vi.fn();
    render(<SettingsPanel open onOpenChange={onOpenChange} />);

    // 模拟 store 里的凭据在面板打开后被外部更新
    act(() => {
      useSettingsStore.setState({
        settings: makeSettings({
          webAccess: { passwordSalt: "salt-new", passwordHash: "hash-new" } as never,
        }),
      } as never);
    });

    act(() => {
      generalSectionProps!.onChange({ ...generalSectionProps!.value, language: "en" } as never);
    });

    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const saved = saveSettings.mock.calls[0][0];
    expect(saved.general.language).toBe("en");
    expect(saved.webAccess.passwordSalt).toBe("salt-new");
    expect(saved.webAccess.passwordHash).toBe("hash-new");
    expect(saveCCChanSettings).toHaveBeenCalledWith(expect.objectContaining(DEFAULT_CCCHAN_SETTINGS));
    // 自动保存不关闭面板
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does not save when nothing was edited", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<SettingsPanel open onOpenChange={onOpenChange} />);

    await user.click(screen.getAllByRole("button", { name: i18n.t("close") }).slice(-1)[0]!);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and reports the error when auto-save fails", async () => {
    const onOpenChange = vi.fn();
    saveSettings.mockRejectedValueOnce(new Error("disk full"));

    render(<SettingsPanel open onOpenChange={onOpenChange} />);
    act(() => {
      generalSectionProps!.onChange({ ...generalSectionProps!.value, language: "en" } as never);
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalled(), { timeout: 2000 });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("flushes a pending edit immediately when closing", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<SettingsPanel open onOpenChange={onOpenChange} />);

    act(() => {
      generalSectionProps!.onChange({ ...generalSectionProps!.value, language: "en" } as never);
    });
    // 不等防抖，直接关闭：最后一笔编辑应立即落盘
    await user.click(screen.getAllByRole("button", { name: i18n.t("close") }).slice(-1)[0]!);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings.mock.calls[0][0].general.language).toBe("en");
  });

  it("resets only the active section after a two-click confirm", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    // 先把 general 改掉，确认重置能打回默认
    act(() => {
      generalSectionProps!.onChange({ ...generalSectionProps!.value, language: "en" } as never);
    });

    getDefaults.mockClear();
    // 第一次点击只是待确认，不重置
    await user.click(screen.getByRole("button", { name: tSettings("resetSection") }));
    expect(toast.info).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: tSettings("resetSectionConfirm") }));
    expect(getDefaults).toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(tSettings("sectionResetDone"));
    expect(generalSectionProps?.value).toEqual(getDefaults().general);
  });
});
