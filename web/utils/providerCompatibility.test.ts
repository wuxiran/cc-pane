import { describe, expect, it } from "vitest";
import type { CliToolInfo } from "@/types";
import {
  compatibleCliToolsForProviderType,
  compatibleProviderTypesForCli,
  isProviderTypeCompatibleWithCli,
} from "./providerCompatibility";

const tools: CliToolInfo[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    versionArgs: [],
    installed: true,
    version: null,
    path: null,
    capabilities: {
      supportsProvider: true,
      supportsResume: true,
      supportsMcp: true,
      supportsSystemPrompt: true,
      supportsWorkspace: true,
      supportsProjectHooks: true,
      compatibleProviderTypes: ["anthropic", "proxy", "config_profile"],
    },
  },
  {
    id: "codex",
    displayName: "Codex",
    executable: "codex",
    versionArgs: [],
    installed: true,
    version: null,
    path: null,
    capabilities: {
      supportsProvider: true,
      supportsResume: true,
      supportsMcp: true,
      supportsSystemPrompt: true,
      supportsWorkspace: true,
      supportsProjectHooks: true,
      compatibleProviderTypes: ["open_ai"],
    },
  },
];

describe("provider compatibility from adapter capabilities", () => {
  it("uses the Rust capability list for filtering", () => {
    expect(compatibleProviderTypesForCli("codex", tools)).toEqual(["open_ai"]);
    expect(isProviderTypeCompatibleWithCli("open_ai", "codex", tools)).toBe(true);
    expect(isProviderTypeCompatibleWithCli("anthropic", "codex", tools)).toBe(false);
  });

  it("plain shell never accepts a provider", () => {
    expect(compatibleProviderTypesForCli("none", tools)).toEqual([]);
    expect(isProviderTypeCompatibleWithCli("anthropic", "none", tools)).toBe(false);
  });

  it("derives provider tabs from the same capability data", () => {
    expect(
      compatibleCliToolsForProviderType("open_ai", tools, ["claude", "codex"]),
    ).toEqual(["codex"]);
  });

  it("keeps UI usable while capabilities are unavailable", () => {
    expect(isProviderTypeCompatibleWithCli("grok", "grok", [])).toBe(true);
  });

  it("uses the stable provider mapping while capabilities are loading", () => {
    expect(isProviderTypeCompatibleWithCli("open_ai", "codex", [])).toBe(true);
    expect(isProviderTypeCompatibleWithCli("anthropic", "codex", [])).toBe(false);
    expect(
      compatibleCliToolsForProviderType("anthropic", [], ["claude", "codex"]),
    ).toEqual(["claude"]);
  });

  it("keeps Pi's managed Provider fallback limited to verified translations", () => {
    expect(isProviderTypeCompatibleWithCli("anthropic", "pi", [])).toBe(true);
    expect(isProviderTypeCompatibleWithCli("open_ai", "pi", [])).toBe(true);
    expect(isProviderTypeCompatibleWithCli("grok", "pi", [])).toBe(true);
    expect(isProviderTypeCompatibleWithCli("kimi", "pi", [])).toBe(false);
    expect(isProviderTypeCompatibleWithCli("opencode", "pi", [])).toBe(false);
    expect(isProviderTypeCompatibleWithCli("proxy", "pi", [])).toBe(false);
    expect(isProviderTypeCompatibleWithCli("config_profile", "pi", [])).toBe(false);
    expect(isProviderTypeCompatibleWithCli("cursor", "pi", [])).toBe(false);
  });

  it("keeps the loading fallback aligned with every CLI adapter", () => {
    const candidates = [
      "claude",
      "codex",
      "pi",
      "gemini",
      "kimi",
      "opencode",
      "cursor",
      "grok",
    ] as const;

    expect(compatibleCliToolsForProviderType("anthropic", [], candidates)).toEqual([
      "claude",
      "pi",
      "opencode",
    ]);
    expect(compatibleCliToolsForProviderType("open_ai", [], candidates)).toEqual([
      "codex",
      "pi",
      "opencode",
    ]);
    expect(compatibleCliToolsForProviderType("opencode", [], candidates)).toEqual(["opencode"]);
    expect(compatibleCliToolsForProviderType("bedrock", [], candidates)).toEqual(["claude", "pi"]);
    expect(compatibleCliToolsForProviderType("vertex", [], candidates)).toEqual(["claude", "pi"]);
    expect(compatibleCliToolsForProviderType("proxy", [], candidates)).toEqual(["claude"]);
    expect(compatibleCliToolsForProviderType("config_profile", [], candidates)).toEqual([
      "claude",
    ]);
    expect(compatibleCliToolsForProviderType("gemini", [], candidates)).toEqual(["pi", "gemini"]);
    expect(compatibleCliToolsForProviderType("kimi", [], candidates)).toEqual(["kimi"]);
    expect(compatibleCliToolsForProviderType("cursor", [], candidates)).toEqual(["cursor"]);
    expect(compatibleCliToolsForProviderType("grok", [], candidates)).toEqual(["pi", "grok"]);
  });
});
