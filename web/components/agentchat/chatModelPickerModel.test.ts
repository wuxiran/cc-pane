import { describe, expect, it } from "vitest";
import type { AcpChatSnapshot } from "@/types/agentChat";
import {
  COLLAPSED_ROWS, effortControl, favoriteRows, filterRows, isFavorite, isPickerManagedOption, modelShortName,
  shortcutIndex, snapshotModels, toggleFavorite, visibleRows, type PickerModelRow,
} from "./chatModelPickerModel";

const row = (modelId: string, engineId = "codex", label = modelId): PickerModelRow => ({ engineId, modelId, label });
const key = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

describe("chatModelPickerModel", () => {
  it("filters by every token across label, id and engine label", () => {
    const rows = [row("gpt-6", "codex", "GPT-6-Astra"), row("opus", "claude", "Claude Opus"), row("o4-mini")];
    const label = (id: string) => (id === "claude" ? "Claude Code" : "Codex");
    expect(filterRows(rows, "astra", label).map((item) => item.modelId)).toEqual(["gpt-6"]);
    expect(filterRows(rows, "  claude   opus ", label).map((item) => item.modelId)).toEqual(["opus"]);
    expect(filterRows(rows, "codex", label).map((item) => item.modelId)).toEqual(["gpt-6", "o4-mini"]);
    expect(filterRows(rows, "", label)).toHaveLength(3);
  });

  it("collapses to the first rows unless expanded or searching", () => {
    const rows = Array.from({ length: COLLAPSED_ROWS + 3 }, (_, index) => row(`m${index}`));
    expect(visibleRows(rows, { expanded: false, query: "" })).toMatchObject({ hidden: 3 });
    expect(visibleRows(rows, { expanded: false, query: "" }).rows).toHaveLength(COLLAPSED_ROWS);
    expect(visibleRows(rows, { expanded: true, query: "" })).toMatchObject({ hidden: 0 });
    expect(visibleRows(rows, { expanded: false, query: "m" }).rows).toHaveLength(rows.length);
    expect(visibleRows(rows.slice(0, COLLAPSED_ROWS), { expanded: false, query: "" }).hidden).toBe(0);
  });

  it("maps the platform modifier plus 1-9 to a row index", () => {
    expect(shortcutIndex(key("1", { metaKey: true }), true)).toBe(0);
    expect(shortcutIndex(key("9", { metaKey: true }), true)).toBe(8);
    expect(shortcutIndex(key("1", { ctrlKey: true }), true)).toBeNull();
    expect(shortcutIndex(key("3", { ctrlKey: true }), false)).toBe(2);
    expect(shortcutIndex(key("3", { metaKey: true }), false)).toBeNull();
    expect(shortcutIndex(key("0", { ctrlKey: true }), false)).toBeNull();
    expect(shortcutIndex(key("2", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(shortcutIndex(key("2"), false)).toBeNull();
  });

  it("toggles favorites and never favorites the engine-default row", () => {
    const once = toggleFavorite([], row("gpt-6"));
    expect(once).toEqual([{ engineId: "codex", modelId: "gpt-6" }]);
    expect(isFavorite(once, row("gpt-6"))).toBe(true);
    expect(isFavorite(once, row("gpt-6", "codex-app-server"))).toBe(false);
    expect(toggleFavorite(once, row("gpt-6"))).toEqual([]);
    const defaultRow = { engineId: "codex", modelId: null, label: "Default" };
    expect(toggleFavorite(once, defaultRow)).toEqual(once);
    expect(isFavorite(once, defaultRow)).toBe(false);
  });

  it("resolves favorite names from known models and drops engines that are gone", () => {
    const favorites = [{ engineId: "codex", modelId: "gpt-6" }, { engineId: "claude", modelId: "opus" }, { engineId: "gone", modelId: "x" }];
    const modelsOf = (id: string) => (id === "codex" ? [row("gpt-6", "codex", "GPT-6-Astra")] : []);
    const rows = favoriteRows(favorites, modelsOf, (id) => id !== "gone");
    expect(rows.map((item) => [item.engineId, item.label])).toEqual([["codex", "GPT-6-Astra"], ["claude", "opus"]]);
  });

  it("reads models legacy-first, falling back to the model config option", () => {
    const legacy: AcpChatSnapshot = {
      chatId: "c", engineId: "claude", phase: "ready",
      models: { currentModelId: "fast", availableModels: [{ modelId: "fast" }, { modelId: "careful", name: "Careful" }] },
      configOptions: [{ configId: "m", category: "model", currentValue: "other", options: [{ value: "other" }] }],
    };
    expect(snapshotModels(legacy)).toMatchObject({ currentId: "fast", configId: null });
    expect(snapshotModels(legacy).rows.map((item) => item.label)).toEqual(["fast", "Careful"]);
    const config = { ...legacy, models: undefined };
    expect(snapshotModels(config)).toMatchObject({ currentId: "other", configId: "m" });
  });

  it("extracts only advertised effort levels from thought_level or Codex reasoning_effort", () => {
    expect(effortControl(undefined)).toBeNull();
    expect(effortControl([{ configId: "mode", category: "mode", options: [{ value: "a" }] }])).toBeNull();
    expect(effortControl([{ configId: "reasoning_effort", type: "select", currentValue: "high", options: [] }])).toBeNull();
    const codex = effortControl([{ configId: "reasoning_effort", type: "select", currentValue: "xhigh",
      options: [{ value: "low" }, { value: "high" }, { value: "xhigh", description: "Extra" }] }]);
    expect(codex?.current).toBe("xhigh");
    expect(codex?.choices.map((choice) => choice.value)).toEqual(["low", "high", "xhigh"]);
    expect(codex?.choices.some((choice) => choice.isDefault)).toBe(false);
    const acp = effortControl([{ configId: "think", category: "thought_level", currentValue: "default",
      options: [{ value: "default", name: "Default" }, { value: "max" }] }]);
    expect(acp?.choices.map((choice) => choice.isDefault)).toEqual([true, false]);
  });

  it("classifies which config options the picker owns", () => {
    expect(isPickerManagedOption({ configId: "m", category: "model" })).toBe(true);
    expect(isPickerManagedOption({ configId: "mode", category: "mode" })).toBe(true);
    expect(isPickerManagedOption({ configId: "reasoning_effort", options: [{ value: "low" }] })).toBe(true);
    expect(isPickerManagedOption({ configId: "budget", category: "model_config", options: [{ value: "1" }] })).toBe(false);
  });

  it("shortens model labels by dropping parentheticals", () => {
    expect(modelShortName("Claude Opus 4 (recommended)")).toBe("Claude Opus 4");
    expect(modelShortName("GPT-6-Astra")).toBe("GPT-6-Astra");
    expect(modelShortName("(x)")).toBe("(x)");
  });
});
