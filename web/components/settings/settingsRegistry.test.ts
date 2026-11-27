import { describe, expect, it } from "vitest";
import {
  getSettingsPanesForPage,
  getVisibleSettingsPages,
  getVisibleSettingsPanes,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  SETTINGS_PANES,
  type SettingsPaneDefinition,
  type SettingsPaneId,
  type SettingsSearchEntry,
} from "./settingsRegistry";
import { getSettingsCommandTargets } from "./settingsSearch";

const findPane = (id: SettingsPaneId) => SETTINGS_PANES.find((pane) => pane.id === id);

describe("settings registry", () => {
  it("declares independent setup and experimental settings pages across two groups", () => {
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
    // 顺序本身是需求：devices 紧跟 system；setup-guide 夹在 usage-stats 与 about 之间
    expect(pageIds).toEqual(["general", "appearance", "terminal", "ai-tools", "system", "devices", "privacy", "ccchan", "experimental", "usage-stats", "setup-guide", "about"]);
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
    expect(visiblePages).toHaveLength(12);
    expect(visiblePages.every((page) =>
      page.paneIds.some((paneId) => visiblePaneIds.includes(paneId))
    )).toBe(true);
  });

  it.each([
    // 外观一站式：颜色/形态/壁纸收进独立 appearance Page（批 5）
    ["general", ["general", "modules"]],
    ["appearance", ["theme", "theme-shape", "wallpaper"]],
    ["ai-tools", ["cli-launchers", "agent-chat", "quick-commands"]],
    ["devices", ["web-access"]],
    ["privacy", ["privacy"]],
    ["ccchan", ["ccchan"]],
  ] as const)("orders panes inside the %s page", (pageId, paneIds) => {
    expect(getSettingsPanesForPage(pageId).map((pane) => pane.id)).toEqual(paneIds);
  });

  it("keeps CC-chan in the services group and web access off the system page", () => {
    expect(SETTINGS_PAGES.find((page) => page.id === "ccchan")?.group).toBe("services");
    const system = SETTINGS_PAGES.find((page) => page.id === "system");
    expect(system?.paneIds).not.toContain("web-access");
    expect(system?.paneIds).toContain("performance");
  });

  it.each<[SettingsPaneId, Partial<SettingsPaneDefinition>]>([
    ["modules", { titleKey: "modules.title", page: "general" }],
    ["usage-stats", { titleKey: "usageStats.title", page: "usage-stats" }],
    ["setup-guide", { titleKey: "setupGuide.title", page: "setup-guide" }],
    ["quick-commands", { titleKey: "quickCommands.title", page: "ai-tools", layout: "wide" }],
    ["performance", { titleKey: "performance.title", page: "system" }],
    ["web-access", { page: "devices" }],
    ["privacy", { page: "privacy", availability: "tauri" }],
    ["ccchan", { page: "ccchan" }],
  ])("declares %s pane metadata", (paneId, expected) => {
    expect(findPane(paneId)).toMatchObject(expected);
  });

  it.each<[SettingsPaneId, Partial<SettingsSearchEntry>]>([
    ["general", { id: "system-resources", titleKey: "showSystemResources", targetSectionId: "general-root" }],
    ["terminal", { id: "path-links", targetSectionId: "terminal-path-links" }],
    ["terminal", { id: "task-queue", targetSectionId: "terminal-task-queue" }],
    ["terminal", { id: "inline-images", titleKey: "inlineImagesEnabled", keywordsKey: "searchKeywords.inlineImages", targetSectionId: "terminal-inline-images" }],
    ["theme", { id: "color", keywordsKey: "searchKeywords.theme", targetSectionId: "theme-color" }],
    ["theme-shape", { id: "shape", keywordsKey: "searchKeywords.themeShape", targetSectionId: "theme-shape" }],
    ["modules", { id: "placement", targetSectionId: "modules-root" }],
    ["usage-stats", { id: "usage-trends", keywordsKey: "searchKeywords.usageStats", targetSectionId: "usage-stats-root" }],
    ["setup-guide", { id: "workflow-checklist", keywordsKey: "searchKeywords.setupGuide", targetSectionId: "setup-guide-root" }],
    ["quick-commands", { id: "library", keywordsKey: "searchKeywords.quickCommands", targetSectionId: "quick-commands-root" }],
    ["performance", { id: "build", keywordsKey: "searchKeywords.performance" }],
    ["performance", { id: "session-priority", titleKey: "lowerSessionPriority", targetSectionId: "performance-session-policy" }],
    ["performance", { id: "keep-awake", titleKey: "performance.keepAwake", targetSectionId: "performance-session-policy" }],
    ["performance", { id: "session-cpu-weight", titleKey: "performance.sessionCpuWeight", targetSectionId: "performance-session-policy" }],
  ])("registers a %s search entry %o", (paneId, entry) => {
    expect(findPane(paneId)?.searchEntries).toContainEqual(expect.objectContaining(entry));
  });

  it("moves the session priority search entry off the terminal pane", () => {
    expect(findPane("terminal")?.searchEntries.some((entry) => entry.titleKey === "lowerSessionPriority")).toBe(false);
  });

  it.each([
    ["web-access", [
      "web-access-root",
      "web-access-device",
      "web-access-server",
      "web-access-auth",
      "web-access-network",
      "web-access-tailscale",
      "web-access-clients",
      "web-access-mcp",
      "web-access-orchestrator",
      "web-access-service",
    ]],
    ["performance", [
      "performance-build",
      "performance-codex",
      "performance-heavy-gate",
      "performance-heavy-ledger",
      "performance-session-policy",
      "performance-session-policy",
      "performance-session-policy",
      "performance-wsl-quota",
      "performance-parking",
    ]],
  ] as const)("makes every %s section searchable", (paneId, sectionIds) => {
    expect(findPane(paneId)?.searchEntries.map((entry) => entry.targetSectionId)).toEqual(sectionIds);
  });
});
