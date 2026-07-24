import { describe, expect, it } from "vitest";
import type { SettingsPaneDefinition } from "./settingsRegistry";
import { searchSettings } from "./settingsSearch";
import { Terminal } from "lucide-react";

const dictionary: Record<string, string> = {
  terminal: "Terminal",
  fontSize: "Font size",
  fontHint: "Choose a readable terminal font",
  fontKeywords: "typography CJK",
  notification: "Notifications",
  notifyExit: "Notify on exit",
};

const panes: SettingsPaneDefinition[] = [
  {
    id: "terminal",
    icon: Terminal,
    titleKey: "terminal",
    group: "appearance",
    searchEntries: [{
      id: "font",
      titleKey: "fontSize",
      descriptionKey: "fontHint",
      keywordsKey: "fontKeywords",
      targetSectionId: "terminal-font",
    }],
  },
  {
    id: "notification",
    icon: Terminal,
    titleKey: "notification",
    group: "system",
    searchEntries: [{
      id: "exit",
      titleKey: "notifyExit",
      targetSectionId: "notification-exit",
    }],
  },
];

const translate = (key: string) => dictionary[key] ?? key;

describe("settings search", () => {
  it("returns no results for an empty query", () => {
    expect(searchSettings(panes, translate, "  ")).toEqual([]);
  });

  it.each([
    ["terminal", "pane", 900],
    ["font size", "entry", 700],
    ["readable", "description", 500],
    ["cjk", "keywords", 300],
  ] as const)("scores %s matches at the %s layer", (query, layer, score) => {
    expect(searchSettings(panes, translate, query)[0]).toMatchObject({ layer, score });
  });

  it("orders stronger layers before weaker layers", () => {
    dictionary.fontKeywords = "notifications";
    const results = searchSettings(panes, translate, "notifications");
    expect(results.map((result) => result.layer)).toEqual(["pane", "keywords"]);
  });
});
