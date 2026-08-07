import { describe, expect, it } from "vitest";
import {
  getSettingsPanesForPage,
  getVisibleSettingsPages,
  getVisibleSettingsPanes,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  SETTINGS_PANES,
} from "./settingsRegistry";
import { getSettingsCommandTargets } from "./settingsSearch";

describe("settings registry", () => {
  it("declares six consolidated pages across two groups", () => {
    const paneIds = SETTINGS_PANES.map((pane) => pane.id);
    const pageIds = SETTINGS_PAGES.map((page) => page.id);
    const groupIds = new Set(SETTINGS_GROUPS.map((group) => group.id));
    const assignedPaneIds = SETTINGS_PAGES.flatMap((page) => page.paneIds);

    expect(new Set(paneIds).size).toBe(paneIds.length);
    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(SETTINGS_PAGES.every((page) => groupIds.has(page.group))).toBe(true);
    expect(new Set(assignedPaneIds)).toEqual(new Set(paneIds));
    expect(assignedPaneIds).toHaveLength(paneIds.length);
    expect(SETTINGS_PANES.every((pane) => Array.isArray(pane.searchEntries))).toBe(true);
    expect(SETTINGS_GROUPS.map((group) => group.id)).toEqual(["application", "services"]);
    expect(pageIds).toEqual(["general", "terminal", "ai-tools", "system", "advanced", "about"]);
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

  it("keeps visible pages and command targets backed by the same pane registry", () => {
    const visiblePanes = getVisibleSettingsPanes({ isMac: false, isTauri: true });
    const visiblePages = getVisibleSettingsPages(visiblePanes);
    const visiblePaneIds = visiblePanes.map((pane) => pane.id);
    const commandPaneIds = [...new Set(
      getSettingsCommandTargets(visiblePanes).map(({ pane }) => pane.id),
    )];

    expect(commandPaneIds).toEqual(visiblePaneIds);
    expect(visiblePages).toHaveLength(6);
    expect(visiblePages.every((page) =>
      page.paneIds.some((paneId) => visiblePaneIds.includes(paneId))
    )).toBe(true);
  });

  it("preserves the intended order inside consolidated pages", () => {
    expect(getSettingsPanesForPage("general").map((pane) => pane.id)).toEqual([
      "general",
      "theme",
      "wallpaper",
      "modules",
    ]);
    expect(getSettingsPanesForPage("ai-tools").map((pane) => pane.id)).toEqual([
      "provider",
      "cli-launchers",
      "shared-mcp",
      "quick-commands",
      "ccchan",
    ]);
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
      page: "general",
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
      page: "advanced",
    });
    expect(setupGuide?.searchEntries).toContainEqual(expect.objectContaining({
      id: "workflow-checklist",
      keywordsKey: "searchKeywords.setupGuide",
      targetSectionId: "setup-guide-root",
    }));
  });

  it("registers quick commands as a wide AI tools pane", () => {
    const quickCommands = SETTINGS_PANES.find((pane) => pane.id === "quick-commands");

    expect(quickCommands).toMatchObject({
      titleKey: "quickCommands.title",
      page: "ai-tools",
      layout: "wide",
    });
    expect(quickCommands?.searchEntries).toContainEqual(expect.objectContaining({
      id: "library",
      keywordsKey: "searchKeywords.quickCommands",
      targetSectionId: "quick-commands-root",
    }));
  });
});
