import { describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW_PRESETS,
  findContextWindowPreset,
} from "./contextWindowPresets";
import {
  MAX_PROVIDER_CONTEXT_WINDOW_TOKENS,
  MIN_PROVIDER_CONTEXT_WINDOW_TOKENS,
} from "@/types/provider";

describe("CONTEXT_WINDOW_PRESETS", () => {
  it("presets are sorted by tokens ascending", () => {
    const tokens = CONTEXT_WINDOW_PRESETS.map((p) => p.tokens);
    const sorted = [...tokens].sort((a, b) => a - b);
    expect(tokens).toEqual(sorted);
  });

  it("all preset tokens fall within provider limits", () => {
    for (const preset of CONTEXT_WINDOW_PRESETS) {
      expect(preset.tokens).toBeGreaterThanOrEqual(MIN_PROVIDER_CONTEXT_WINDOW_TOKENS);
      expect(preset.tokens).toBeLessThanOrEqual(MAX_PROVIDER_CONTEXT_WINDOW_TOKENS);
    }
  });

  it("preset tokens are unique", () => {
    const seen = new Set<number>();
    for (const preset of CONTEXT_WINDOW_PRESETS) {
      expect(seen.has(preset.tokens)).toBe(false);
      seen.add(preset.tokens);
    }
  });

  it("includes both 1M and 2M long-context extremes", () => {
    expect(findContextWindowPreset(1_000_000)).toBeDefined();
    expect(findContextWindowPreset(2_000_000)).toBeDefined();
  });
});

describe("findContextWindowPreset", () => {
  it("returns the matching preset for a known value", () => {
    const preset = findContextWindowPreset(200_000);
    expect(preset?.tokens).toBe(200_000);
  });

  it("returns undefined for null or undefined", () => {
    expect(findContextWindowPreset(null)).toBeUndefined();
    expect(findContextWindowPreset(undefined)).toBeUndefined();
  });

  it("returns undefined when no preset matches", () => {
    expect(findContextWindowPreset(123_456)).toBeUndefined();
  });
});
