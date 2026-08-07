import "@/i18n";
import type { ComponentProps } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores";
import FeatureTip from "./FeatureTip";
import { FEATURE_TIPS, type FeatureTipDefinition } from "./featureTipRegistry";

const openUrl = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const definition: FeatureTipDefinition = {
  id: "command-palette",
  actionId: "command-palette",
  titleKey: "featureTips.commandPalette.title",
  bodyKey: "featureTips.commandPalette.body",
  bodyUnboundKey: "featureTips.commandPalette.bodyUnbound",
  visual: () => <div>visual</div>,
  tryAction: vi.fn(),
};

function renderTip(overrides: Partial<ComponentProps<typeof FeatureTip>> = {}) {
  const props = {
    definition,
    onTry: vi.fn(),
    onDismiss: vi.fn(),
    onDisable: vi.fn(),
    onOpenShortcuts: vi.fn(),
    ...overrides,
  };
  render(<FeatureTip {...props} />);
  return props;
}

describe("FeatureTip", () => {
  beforeEach(() => {
    openUrl.mockClear();
    vi.spyOn(window, "open").mockReturnValue(null);
    const settings = useSettingsStore.getState().getDefaults();
    useSettingsStore.setState({
      settings: {
        ...settings,
        shortcuts: {
          ...settings.shortcuts,
          bindings: { ...settings.shortcuts.bindings, "command-palette": "Alt+P" },
        },
      },
    });
  });

  it("实时显示用户绑定的键位，不使用默认硬编码", () => {
    renderTip();

    expect(screen.getByText("Alt+P")).toBeInTheDocument();
    expect(screen.queryByText("Ctrl+K")).not.toBeInTheDocument();
  });

  it("解绑后隐藏 chip 并切换为绑定引导文案", () => {
    renderTip();
    const current = useSettingsStore.getState().settings!;

    act(() => {
      useSettingsStore.setState({
        settings: {
          ...current,
          shortcuts: { ...current.shortcuts, bindings: { ...current.shortcuts.bindings, "command-palette": "" } },
        },
      });
    });

    expect(screen.queryByText("Alt+P")).not.toBeInTheDocument();
    expect(screen.getByText(/去设置绑定命令面板快捷键|Bind the Command Palette in Settings/i)).toBeInTheDocument();
  });

  // 限制说明从 TERMINAL_PASSTHROUGH_ACTIONS 派生，不是每条 tip 手写
  it("actionId 在终端放行清单内时渲染限制说明", () => {
    renderTip();

    expect(screen.getByTestId("feature-tip-passthrough-hint")).toBeInTheDocument();
  });

  it("actionId 不在放行清单内时不渲染限制说明", () => {
    const current = useSettingsStore.getState().settings!;
    useSettingsStore.setState({
      settings: {
        ...current,
        shortcuts: {
          ...current.shortcuts,
          bindings: { ...current.shortcuts.bindings, "toggle-layouts": "Ctrl+Alt+L" },
        },
      },
    });

    renderTip({
      definition: {
        ...definition,
        id: "layout-switcher",
        actionId: "toggle-layouts",
        titleKey: "featureTips.layoutSwitcher.title",
        bodyKey: "featureTips.layoutSwitcher.body",
        bodyUnboundKey: "featureTips.layoutSwitcher.bodyUnbound",
      },
    });

    expect(screen.queryByTestId("feature-tip-passthrough-hint")).not.toBeInTheDocument();
  });

  it("未绑定快捷键时不同时冒出限制说明", () => {
    const current = useSettingsStore.getState().settings!;
    useSettingsStore.setState({
      settings: {
        ...current,
        shortcuts: {
          ...current.shortcuts,
          bindings: { ...current.shortcuts.bindings, "command-palette": "" },
        },
      },
    });

    renderTip();

    expect(screen.queryByTestId("feature-tip-passthrough-hint")).not.toBeInTheDocument();
  });

  it("没有落点教程时不渲染「查看教程」", () => {
    renderTip();

    expect(screen.queryByTestId("feature-tip-guide-link")).not.toBeInTheDocument();
  });

  it("有落点教程时渲染链接，点击按既有惯例打开 GitHub 上的 guide", async () => {
    const user = userEvent.setup();
    renderTip({
      definition: { ...definition, guidePath: "docs/guide/12-leader-worker.md" },
    });

    await user.click(screen.getByTestId("feature-tip-guide-link"));

    // 桌面壳里走 plugin-opener（与 UpdateNotification 同一条既有惯例）
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/wuxiran/cc-pane/blob/main/docs/guide/12-leader-worker.md",
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it("执行试试看、知道了和快捷键设置动作", async () => {
    const user = userEvent.setup();
    const props = renderTip();

    await user.click(screen.getByRole("button", { name: /试试看|Try it/i }));
    expect(props.onTry).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /知道了|Got it/i }));
    expect(props.onDismiss).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /随时重新绑定|Rebind this shortcut/i }));
    expect(props.onOpenShortcuts).toHaveBeenCalledOnce();
  });

  it("显示界面形态文案和六种预览", () => {
    const shapeTip = FEATURE_TIPS.find((entry) => entry.id === "interface-shapes");
    expect(shapeTip).toBeDefined();

    renderTip({ definition: shapeTip! });

    expect(screen.getByText(/试试界面形态|Try interface shapes/i)).toBeInTheDocument();
    expect(document.querySelectorAll("[data-shape-preview]")).toHaveLength(6);
    expect(screen.queryByRole("button", { name: /随时重新绑定|Rebind this shortcut/i })).not.toBeInTheDocument();
  });
});
