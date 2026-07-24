import { describe, expect, it } from "vitest";
import {
  getVisibleSettingsPanes,
  SETTINGS_GROUPS,
  SETTINGS_PANES,
} from "./settingsRegistry";

describe("settings registry", () => {
  it("declares unique panes in known groups", () => {
    const paneIds = SETTINGS_PANES.map((pane) => pane.id);
    const groupIds = new Set(SETTINGS_GROUPS.map((group) => group.id));

    expect(new Set(paneIds).size).toBe(paneIds.length);
    expect(SETTINGS_PANES.every((pane) => groupIds.has(pane.group))).toBe(true);
    expect(SETTINGS_PANES.every((pane) => Array.isArray(pane.searchEntries))).toBe(true);
  });

  it("applies desktop and platform availability from the registry", () => {
    const web = getVisibleSettingsPanes({ isMac: false, isTauri: false });
    const windowsDesktop = getVisibleSettingsPanes({ isMac: false, isTauri: true });
    const macDesktop = getVisibleSettingsPanes({ isMac: true, isTauri: true });

    expect(web.map((pane) => pane.id)).not.toContain("wallpaper");
    expect(windowsDesktop.map((pane) => pane.id)).toContain("wallpaper");
    expect(windowsDesktop.map((pane) => pane.id)).toContain("screenshot");
    expect(macDesktop.map((pane) => pane.id)).not.toContain("screenshot");
  });
});
