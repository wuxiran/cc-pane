import { describe, expect, it } from "vitest";
import { shouldOpenOnboarding } from "./onboardingStartup";

describe("shouldOpenOnboarding", () => {
  it("opens only for loaded settings explicitly marked incomplete", () => {
    expect(shouldOpenOnboarding(null)).toBe(false);
    expect(shouldOpenOnboarding({ onboardingCompleted: true })).toBe(false);
    expect(shouldOpenOnboarding({ onboardingCompleted: false })).toBe(true);
  });
});
