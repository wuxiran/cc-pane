import { describe, expect, it } from "vitest";
import {
  isValidProviderContextWindowTokens,
  type ProviderModel,
} from "./provider";

describe("ProviderModel", () => {
  it("carries an optional context window token count", () => {
    const model: ProviderModel = {
      id: "gpt-5.4",
      contextWindowTokens: 353_000,
    };

    expect(model.contextWindowTokens).toBe(353_000);
  });
});

describe("isValidProviderContextWindowTokens", () => {
  it.each([
    [undefined, true],
    [null, true],
    [999, false],
    [1_000, true],
    [10_000_000, true],
    [10_000_001, false],
    [10_000.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
  ])("validates %s", (value, expected) => {
    expect(isValidProviderContextWindowTokens(value)).toBe(expected);
  });
});
