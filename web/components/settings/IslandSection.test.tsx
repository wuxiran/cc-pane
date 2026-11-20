import "@/i18n";
import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores";
import { DEFAULT_ISLAND_SETTINGS } from "@/types/island";
import { createTestSettings } from "@/test/utils/testData";
import IslandSection from "./IslandSection";
import { createSettingsDraft, resetSettingsSection } from "./settingsDraft";

describe("island settings", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("defaults to disabled with the documented options", () => {
    expect(useSettingsStore.getState().getDefaults().island).toEqual({
      enabled: false,
      position: "top",
      display: "mouse",
      popOnFinish: true,
      showQuota: true,
      collapseInFullscreen: true,
      hideWhenMainFocused: false,
    });
  });

  it("fills a missing island section when building the settings draft and resets it by pane", () => {
    const legacy = createTestSettings();
    delete (legacy as Partial<typeof legacy>).island;
    const draft = createSettingsDraft(legacy);
    expect(draft.island).toEqual(DEFAULT_ISLAND_SETTINGS);
    const edited = { ...draft, island: { ...draft.island, enabled: true, position: "left" as const } };
    const defaults = createSettingsDraft(useSettingsStore.getState().getDefaults());
    expect(resetSettingsSection(edited, defaults, "island").island).toEqual(DEFAULT_ISLAND_SETTINGS);
  });

  it("edits enable, position and toggles through onChange", () => {
    const onChange = vi.fn();
    const { rerender } = render(<IslandSection value={DEFAULT_ISLAND_SETTINGS} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("启用灵动岛"));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_ISLAND_SETTINGS, enabled: true });

    const enabled = { ...DEFAULT_ISLAND_SETTINGS, enabled: true };
    rerender(<IslandSection value={enabled} onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "右侧" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...enabled, position: "right" });
    fireEvent.click(screen.getByLabelText("主窗口在前台时隐藏"));
    expect(onChange).toHaveBeenLastCalledWith({ ...enabled, hideWhenMainFocused: true });
  });
});
