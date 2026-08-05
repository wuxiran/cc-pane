import { describe, expect, it } from "vitest";
import type { LaunchProfile, Provider } from "@/types";
import { normalizeContextPercentage, resolveContextDisplayModel } from "./contextUsageModel";

function profile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: "profile-1",
    name: "Claude profile",
    providerId: "provider-1",
    modelId: null,
    targetTools: ["claude"],
    mcpPolicy: {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
    },
    skillPolicy: {
      mode: "core",
      enabledSkillIds: [],
      disabledSkillIds: [],
      profileSkills: [],
      includeProjectSkills: true,
      includeExternalClaudeSkills: true,
      includeExternalCodexSkills: true,
      includeExternalPluginSkills: true,
      target: "session",
    },
    isDefault: false,
    createdAt: "2026-08-04T00:00:00Z",
    updatedAt: "2026-08-04T00:00:00Z",
    ...overrides,
  };
}

const provider: Provider = {
  id: "provider-1",
  name: "Anthropic proxy",
  providerType: "anthropic",
  models: [
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  ],
  defaultModelId: "claude-sonnet-5",
  isDefault: true,
};

describe("resolveContextDisplayModel", () => {
  it("prefers the profile Provider default over a proxy-reported model", () => {
    expect(resolveContextDisplayModel(
      {
        providerId: null,
        modelId: null,
        providerSelection: null,
        launchProfileId: "profile-1",
      },
      "MiniMax-M3",
      [profile()],
      [provider],
    )).toBe("Sonnet 5");
  });

  it("uses the profile model when the profile overrides the Provider default", () => {
    expect(resolveContextDisplayModel(
      {
        providerId: null,
        modelId: null,
        providerSelection: "inherit",
        launchProfileId: "profile-1",
      },
      "MiniMax-M3",
      [profile({ modelId: "claude-sonnet-4-6" })],
      [provider],
    )).toBe("Sonnet 4.6");
  });

  it("keeps the reported model for Native mode", () => {
    expect(resolveContextDisplayModel(
      {
        providerId: null,
        modelId: null,
        providerSelection: "none",
        launchProfileId: "profile-1",
      },
      "MiniMax-M3",
      [profile()],
      [provider],
    )).toBe("MiniMax-M3");
  });
});

describe("normalizeContextPercentage", () => {
  it.each([
    [null, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [-1, null],
    [101, null],
    [12.5, null],
    [0, 0],
    [100, 100],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeContextPercentage(value as number | null)).toBe(expected);
  });
});
