import "@/i18n";
import i18n from "i18next";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "@/components/SettingsPanel";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useCCChanStore } from "@/stores/useCCChanStore";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import type { AppSettings } from "@/types";

vi.mock("@/components/settings/SettingsPaneContent", () => ({
  default: () => <div data-testid="pane-content" />,
}));
vi.mock("@/lib/feedback", () => ({ toastOk: vi.fn(), toastErr: vi.fn(), toastInfo: vi.fn() }));

const defaults = useSettingsStore.getState().getDefaults();
const translate = i18n.t as (key: string, options: Record<string, unknown>) => string;
const t = (key: string) => translate(key, { ns: "settings" });
const save = vi.fn<(value: AppSettings) => Promise<void>>().mockResolvedValue(undefined);

beforeEach(() => {
  const settings = structuredClone(defaults);
  settings.terminal.lowerSessionPriority = false;
  settings.terminal.sessionCpuWeight = 2;
  settings.terminal.fontSize = 24;
  useSettingsStore.setState({ settings, saveSettings: save, getDefaults: () => structuredClone(defaults) });
  useCCChanStore.setState({ saveSettings: vi.fn().mockResolvedValue(undefined) });
  useBrowserWebviewOverlayStore.setState({ blockers: new Set() });
});

afterEach(() => {
  cleanup();
  save.mockClear();
});

async function resetActive(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: t("resetSection") }));
  await user.click(screen.getByRole("button", { name: t("resetSectionConfirm") }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  return save.mock.calls[0][0];
}

describe("settings reset respects visible section ownership", () => {
  it("performance reset restores its policy fields and preserves terminal appearance", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: t("pages.system.title") }));
    await user.click(screen.getByRole("tab", { name: t("performance.title") }));
    const saved = await resetActive(user);
    expect(saved.terminal.lowerSessionPriority).toBe(true);
    expect(saved.terminal.sessionCpuWeight).toBeNull();
    expect(saved.terminal.fontSize).toBe(24);
  });

  it("terminal reset preserves policy fields now displayed on performance", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: t("pages.terminal.title") }));
    const saved = await resetActive(user);
    expect(saved.terminal.lowerSessionPriority).toBe(false);
    expect(saved.terminal.sessionCpuWeight).toBe(2);
    expect(saved.terminal.fontSize).toBe(defaults.terminal.fontSize);
  });
});
