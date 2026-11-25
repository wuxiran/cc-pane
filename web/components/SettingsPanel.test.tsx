import "@/i18n";
import i18n from "i18next";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODULE_REGISTRY } from "@/modules/registry";
import { toastErr, toastInfo } from "@/lib/feedback";
import type { AppSettings } from "@/types";
import { useSettingsStore } from "@/stores";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import * as runtime from "@/services/runtime";
import SettingsPanel from "./SettingsPanel";

vi.mock("@/lib/feedback", () => ({
  toastOk: vi.fn(),
  toastErr: vi.fn(),
  toastInfo: vi.fn(),
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
  // 真实分区以 SettingsSection title={t("screenshot")} 渲染小节标题；mock 保持同一可访问标题。
  default: () => (
    <section data-testid="screenshot-section">
      <h3>{i18n.t("screenshot", { ns: "settings" })}</h3>
    </section>
  ),
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
      "--settings-sidebar-width": "clamp(11rem, 20cqw, 15rem)",
      "--settings-content-gutter": "clamp(1rem, 3cqw, 2.5rem)",
    });
    expect(dialog).toHaveClass("resize");
    // 细标题行：面包屑「设置 / 常规」+ 右侧关闭
    const header = screen.getByTestId("settings-dialog-header");
    expect(header).toHaveTextContent(`${tSettings("title")}/${tSettings("pages.general.title")}`);
    expect(within(header).getByRole("button", { name: i18n.t("close") })).toBeInTheDocument();
    expect(screen.getByTestId("settings-content-container")).toHaveStyle({
      paddingInline: "var(--settings-content-gutter)",
    });
    expect(screen.getByRole("navigation", { name: tSettings("navigation") })).toHaveClass("w-[var(--settings-sidebar-width)]");
    expect(dialog).not.toHaveClass("!h-screen", "!w-screen", "!rounded-none");

    for (const group of ["application", "services"] as const) {
      expect(screen.getByText(tSettings(`groups.${group}`))).toBeInTheDocument();
    }
    for (const page of ["general", "terminal", "aiTools", "system", "devices", "usageStats", "about"] as const) {
      expect(screen.getByRole("button", { name: tSettings(`pages.${page}.title`) })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: tSettings("setupGuide.title") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: tSettings("experimental.title") })).toBeInTheDocument();
    // 页标题只出现一次（页面内的 h1），不再有折叠分段组
    expect(screen.getAllByRole("heading", { name: tSettings("pages.general.title") })).toHaveLength(1);
    expect(screen.queryByRole("group", { name: tSettings("paneNavigation") })).not.toBeInTheDocument();
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
    expect(await screen.findByTestId("cli-launchers-section")).toBeInTheDocument();
    // 技能已移到资源库，AI 工具页不再有 Skills 标签
    expect(screen.queryByRole("button", { name: /^Skills/ })).not.toBeInTheDocument();
  });

  it("no longer hosts provider panes: AI tools opens on CLI launchers", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("pages.aiTools.title") }));
    expect(await screen.findByTestId("cli-launchers-section")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(tSettings("providerCredentialsTab")) })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(tSettings("launchProfilesTab")) })).not.toBeInTheDocument();
  });

  it("stacks every section of a page flat, without accordion headers", async () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    expect(await screen.findByTestId("general-section")).toBeInTheDocument();
    // 「模块」不再是可折叠分段，而是同页里的一个普通分区
    expect(await screen.findByTestId("module-setting-ssh", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId("settings-pane-accordion")).not.toBeInTheDocument();
    // 下拉菜单触发器自带 aria-expanded，排除后不应再有任何折叠头
    expect(document.querySelector("[aria-expanded]:not([aria-haspopup])")).toBeNull();
  });

  it("renders the registry-backed module settings on the general page", async () => {
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: tSettings("modules.title") })).toBeInTheDocument();
    expect(await screen.findByTestId("module-setting-ssh", {}, { timeout: 5000 })).toBeInTheDocument();
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
    expect(await screen.findByTestId("screenshot-section")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: tSettings("screenshot") })).toBeInTheDocument();
  });

  it("hosts web access on the devices page instead of the system page", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: tSettings("pages.system.title") }));
    expect(await screen.findByTestId("proxy-section")).toBeInTheDocument();
    expect(screen.queryByTestId("web-access-section")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: tSettings("pages.devices.title") }));
    expect(await screen.findByTestId("web-access-section")).toBeInTheDocument();
    expect(screen.queryByTestId("proxy-section")).not.toBeInTheDocument();
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
    expect(saveCCChanSettings).not.toHaveBeenCalled();
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

    await waitFor(() => expect(toastErr).toHaveBeenCalled(), { timeout: 2000 });
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
    expect(toastInfo).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: tSettings("resetSectionConfirm") }));
    expect(getDefaults).toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(tSettings("sectionResetDone"));
    expect(generalSectionProps?.value).toEqual(getDefaults().general);
  });
});

describe("SettingsPanel window presentation", () => {
  it("独立窗口形态不显示重复的关闭入口", () => {
    vi.spyOn(runtime, "getCurrentWindowIfTauri").mockReturnValue(null);
    render(<SettingsPanel open onOpenChange={vi.fn()} presentation="window" />);
    expect(screen.getByTestId("settings-dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^关闭$|^Close$/ })).not.toBeInTheDocument();
  });
});
