import { describe, expect, it } from "vitest";
import {
  getVisibleSettingsPanes,
  SETTINGS_GROUPS,
  SETTINGS_PANES,
} from "./settingsRegistry";
import { getSettingsCommandTargets } from "./settingsSearch";

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

  it("drives sidebar panes and command targets from the same visible registry", () => {
    const visiblePanes = getVisibleSettingsPanes({ isMac: false, isTauri: true });
    const sidebarPaneIds = visiblePanes.map((pane) => pane.id);
    const commandPaneIds = [...new Set(
      getSettingsCommandTargets(visiblePanes).map(({ pane }) => pane.id),
    )];

    expect(commandPaneIds).toEqual(sidebarPaneIds);
  });

  it("registers the status bar system resource setting for search", () => {
    const general = SETTINGS_PANES.find((pane) => pane.id === "general");

    expect(general?.searchEntries).toContainEqual(expect.objectContaining({
      id: "system-resources",
      titleKey: "showSystemResources",
      targetSectionId: "general-root",
    }));
  });

  it("registers the module pane and its placement search target", () => {
    const modules = SETTINGS_PANES.find((pane) => pane.id === "modules");

    expect(modules).toMatchObject({
      titleKey: "modules.title",
      group: "appearance",
    });
    expect(modules?.searchEntries).toContainEqual(expect.objectContaining({
      id: "placement",
      targetSectionId: "modules-root",
    }));
  });

  it("registers the setup guide and its searchable checklist target", () => {
    const setupGuide = SETTINGS_PANES.find((pane) => pane.id === "setup-guide");

    expect(setupGuide).toMatchObject({
      titleKey: "setupGuide.title",
      group: "guide",
    });
    expect(setupGuide?.searchEntries).toContainEqual(expect.objectContaining({
      id: "workflow-checklist",
      keywordsKey: "searchKeywords.setupGuide",
      targetSectionId: "setup-guide-root",
    }));
  });
});
