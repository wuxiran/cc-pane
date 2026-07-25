import "@/i18n";
import type { ComponentProps } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores";
import FeatureTip from "./FeatureTip";
import type { FeatureTipDefinition } from "./featureTipRegistry";

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
});
