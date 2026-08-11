import "@/i18n";
import i18n from "i18next";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_REGISTRY } from "@/modules/registry";
import { toast } from "sonner";
import type { AppSettings } from "@/types";
import { useSettingsStore } from "@/stores";
import { DEFAULT_CCCHAN_SETTINGS, useCCChanStore } from "@/stores/useCCChanStore";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
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
  default: ({ view, onDirtyChange }: { view: string; onDirtyChange?: (dirty: boolean) => void }) => (
    <div data-testid="provider-section" data-view={view}>
      <button type="button" onClick={() => onDirtyChange?.(true)}>mark-provider-settings-dirty</button>
    </div>
  ),
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
vi.mock("@/components/resources/GlobalSkillsPanel", () => ({
  default: () => <div data-testid="skills-section" />,
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
vi.mock("./settings/ExperimentalSection", () => ({
  default: () => <div data-testid="experimental-section" />,
}));
vi.mock("@/components/onboarding/SetupGuideChecklist", () => ({
  default: () => <div data-testid="setup-guide-section" />,
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
    useBrowserWebviewOverlayStore.setState({ blockers: new Set() });
    useSettingsStore.setState({
      settings: makeSettings(),
      saveSettings,
      getDefaults,
    } as never);
    useCCChanStore.setState({ saveSettings: saveCCChanSettings } as never);
  });

  afterEach(() => {
    useBrowserWebviewOverlayStore.setState({ blockers: new Set() });
    generalSectionProps = null;
    vi.clearAllMocks();
  });

  it("opens on the general section with the settings dialog title", async () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    expect(screen.getByText(tSettings("title"))).toBeInTheDocument();
    expect(await screen.findByTestId("general-section")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-section")).not.toBeInTheDocument();
  });

  it("uses a viewport-relative, resizable modal and independent navigation pages", () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    const dialog = screen.getByTestId("settings-dialog");
    expect(dialog).toHaveStyle({
      width: "88vw",
      height: "82vh",
      maxWidth: "calc(100vw - 2rem)",
      maxHeight: "calc(100vh - 2rem)",
      containerType: "inline-size",
      "--settings-sidebar-width": "clamp(10rem, 18cqw, 18rem)",
      "--settings-content-gutter": "clamp(1rem, 2cqw, 2rem)",
    });
    expect(dialog).toHaveClass("resize");
    expect(screen.getByTestId("settings-dialog-header")).toHaveStyle({
      gridTemplateColumns: "calc(var(--settings-sidebar-width) + var(--settings-content-gutter) - var(--settings-chrome-gutter)) minmax(0, 1fr) auto",
    });
    expect(screen.getByTestId("settings-content-container")).toHaveStyle({
      paddingInline: "var(--settings-content-gutter)",
    });
    expect(screen.getByRole("navigation", { name: tSettings("navigation") })).toHaveClass("w-[var(--settings-sidebar-width)]");
    expect(dialog).not.toHaveClass("!h-screen", "!w-screen", "!rounded-none");

    for (const group of ["application", "services"] as const) {
      expect(screen.getByText(tSettings(`groups.${group}`))).toBeInTheDocument();
    }
    for (const page of ["general", "terminal", "aiTools", "system", "usageStats", "about"] as const) {
      expect(screen.getByRole("button", { name: tSettings(`pages.${page}.title`) })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: tSettings("setupGuide.title") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: tSettings("experimental.title") })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: tSettings("pages.general.title") })).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: tSettings("paneNavigation") })).toBeInTheDocument();
    expect(screen.getByText("CC-Panes")).toBeInTheDocument();
  });

  it("blocks native browser webviews while the settings dialog is open", async () => {
    const view = render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(useBrowserWebviewOverlayStore.getState().blockers).toContain("settings-panel");
    });

    view.rerender(<SettingsPanel open={false} onOpenChange={vi.fn()} />);

    await waitFor(() => {
      expect(useBrowserWebviewOverlayStore.getState().blockers).not.toContain("settings-panel");
    });
  });

  it("syncs the draft from the stored settings when opened", async () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await waitFor(() => expect(generalSectionProps?.value).toEqual(makeSettings().general));
  });

  it("switches consolidated pages and their secondary sections", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("pages.terminal.title") }));
    expect(await screen.findByTestId("terminal-section")).toBeInTheDocument();
    expect(screen.queryByTestId("general-section")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: tSettings("pages.aiTools.title") }));
    await user.click(screen.getByRole("tab", { name: tSettings("sharedMcp.title") }));
    expect(await screen.findByTestId("shared-mcp-section")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: tSettings("skills") }));
    const skillsSection = await screen.findByTestId("skills-section");
    expect(skillsSection).toBeInTheDocument();
    expect(skillsSection.closest('[data-settings-section="skills-root"]')).toHaveClass("h-full", "min-h-0");
  });

  it("lets full-height settings panes constrain their internal scroll areas", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("pages.aiTools.title") }));

    const providerSection = await screen.findByTestId("provider-section");
    const paneRoot = providerSection.closest('[data-settings-section="provider-root"]');
    expect(paneRoot).toHaveClass("h-full", "min-h-0");
  });

  it("keeps launch profiles and provider credentials as separate AI tools panes", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("pages.aiTools.title") }));
    expect(await screen.findByTestId("provider-section")).toHaveAttribute("data-view", "profiles");

    await user.click(screen.getByRole("tab", { name: tSettings("providerCredentialsTab") }));
    expect(await screen.findByTestId("provider-section")).toHaveAttribute("data-view", "providers");
  });

  it("asks before leaving a settings pane with unsaved provider changes", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("pages.aiTools.title") }));
    await user.click(await screen.findByRole("button", { name: "mark-provider-settings-dirty" }));
    await user.click(screen.getByRole("button", { name: tSettings("pages.general.title") }));

    expect(screen.getByTestId("provider-section")).toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: i18n.t("unsavedChangesTitle", { ns: "common" }) })).toBeVisible();

    await user.click(screen.getByRole("button", { name: i18n.t("discardChanges", { ns: "common" }) }));
    expect(await screen.findByTestId("general-section")).toBeInTheDocument();
  });

  it("keeps settings open until unsaved provider changes are discarded", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<SettingsPanel open onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: tSettings("pages.aiTools.title") }));
    await user.click(await screen.findByRole("button", { name: "mark-provider-settings-dirty" }));
    await user.click(screen.getAllByRole("button", { name: i18n.t("close") }).slice(-1)[0]!);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: i18n.t("unsavedChangesTitle", { ns: "common" }) })).toBeVisible();

    await user.click(screen.getByRole("button", { name: i18n.t("discardChanges", { ns: "common" }) }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismisses an unsaved provider prompt when settings closes externally", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const view = render(<SettingsPanel open onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: tSettings("pages.aiTools.title") }));
    await user.click(await screen.findByRole("button", { name: "mark-provider-settings-dirty" }));
    await user.click(screen.getAllByRole("button", { name: i18n.t("close") }).slice(-1)[0]!);
    expect(await screen.findByRole("dialog", { name: i18n.t("unsavedChangesTitle", { ns: "common" }) })).toBeVisible();

    view.rerender(<SettingsPanel open={false} onOpenChange={onOpenChange} />);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: i18n.t("unsavedChangesTitle", { ns: "common" }) })).not.toBeInTheDocument();
    });
  });

  it("opens the registry-backed module settings pane", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: tSettings("modules.title") }));

    expect(await screen.findByTestId("module-setting-ssh")).toBeInTheDocument();
    const configurableModuleCount = MODULE_REGISTRY.filter((module) => module.configurable !== false).length;
    expect(screen.getAllByTestId(/^module-setting-/)).toHaveLength(configurableModuleCount);
  });

  it("opens the persistent setup guide from the settings navigation", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("setupGuide.title") }));

    expect(await screen.findByTestId("setup-guide-section")).toBeInTheDocument();
    expect(screen.queryByTestId("general-section")).not.toBeInTheDocument();
  });

  it("opens CC-chan as an independent service page", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("ccchanTitle") }));

    expect(await screen.findByTestId("ccchan-section")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-section")).not.toBeInTheDocument();
  });

  it("shows the screenshot section on non-mac platforms", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("pages.system.title") }));
    expect(screen.getByRole("tab", { name: tSettings("screenshot") })).toBeInTheDocument();
  });

  it("searches the registry and lazily opens the highest-ranked pane", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole("searchbox", { name: tSettings("searchLabel") }), "字体");

    expect(await screen.findByTestId("terminal-section")).toBeInTheDocument();
    expect(screen.queryByTestId("general-section")).not.toBeInTheDocument();
  });

  it("finds the setup guide through its workflow keywords", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole("searchbox", { name: tSettings("searchLabel") }), "多开");

    expect(await screen.findByTestId("setup-guide-section")).toBeInTheDocument();
    expect(screen.queryByTestId("general-section")).not.toBeInTheDocument();
  });

  it("renders the experimental shell without mounting another pane", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("experimental.title") }));

    expect(await screen.findByTestId("experimental-section")).toBeInTheDocument();
    expect(screen.queryByTestId("general-section")).not.toBeInTheDocument();
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
