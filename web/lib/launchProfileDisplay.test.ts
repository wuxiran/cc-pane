import { describe, expect, it } from "vitest";
import type { LaunchProfile } from "@/types/launch-profile";
import type { Provider } from "@/types/provider";
import { describeLaunchProfile, type LaunchProfileDisplayContext } from "./launchProfileDisplay";

function profile(overrides: Partial<LaunchProfile>): LaunchProfile {
  return {
    id: "p1",
    name: "工作",
    targetTools: [],
    mcpPolicy: { mode: "default", enabledServerIds: [], disabledServerIds: [], includeCcpanesMcp: true, includeSharedMcp: true },
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
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const relay: Provider = {
  id: "relay",
  name: "Magpie",
  providerType: "anthropic",
  isDefault: false,
  defaultModelId: "group/code",
  accounts: [{ id: "k1", name: "主密钥", kind: "api_key" }],
};
const loginProvider: Provider = {
  id: "login",
  name: "Claude 订阅",
  providerType: "anthropic",
  isDefault: false,
  accounts: [
    { id: "a1", name: "me@example.com", kind: "login" },
    { id: "a2", name: "team@example.com", kind: "login" },
  ],
  defaultAccountId: "a1",
};

function ctx(overrides: Partial<LaunchProfileDisplayContext> = {}): LaunchProfileDisplayContext {
  return { profiles: [], profilesLoaded: true, providers: [relay, loginProvider], mode: "terminal", ...overrides };
}

describe("describeLaunchProfile", () => {
  it("shows the live profile name (alias wins) with relay credential and session model", () => {
    const display = describeLaunchProfile(
      { launchProfileId: "p1", cliTool: "claude", providerId: "relay", modelId: "opus" },
      ctx({ profiles: [profile({ alias: "改过的名字" })] }),
    );
    expect(display).toEqual({
      kind: "profile",
      name: "改过的名字",
      credential: { kind: "relay", name: "Magpie" },
      model: "opus",
    });
  });

  it("falls back to the profile's provider and the provider default model", () => {
    const display = describeLaunchProfile(
      { launchProfileId: "p1", cliTool: "claude" },
      ctx({ profiles: [profile({ providerId: "relay" })] }),
    );
    expect(display.credential).toEqual({ kind: "relay", name: "Magpie" });
    expect(display.model).toBe("group/code");
  });

  it("names the login account (OAuth) and honours an explicit account", () => {
    const display = describeLaunchProfile(
      { launchProfileId: "p1", providerId: "login", providerAccountId: "a2" },
      ctx({ profiles: [profile({})] }),
    );
    expect(display.credential).toEqual({ kind: "login", name: "team@example.com" });
  });

  it("degrades to deleted once profiles have loaded, unknown before that", () => {
    expect(describeLaunchProfile({ launchProfileId: "gone" }, ctx()).kind).toBe("deleted");
    expect(describeLaunchProfile({ launchProfileId: "gone" }, ctx({ profilesLoaded: false })).kind).toBe("unknown");
  });

  it("terminal: empty id resolves to the CLI-matching default profile, else system default", () => {
    const profiles = [
      profile({ id: "codex-default", name: "Codex 默认", isDefault: true, targetTools: ["codex"] }),
      profile({ id: "claude-default", name: "Claude 默认", isDefault: true, targetTools: ["claude"] }),
    ];
    const claude = describeLaunchProfile({ cliTool: "claude" }, ctx({ profiles }));
    expect(claude).toMatchObject({ kind: "implicitDefault", name: "Claude 默认" });
    const gemini = describeLaunchProfile({ cliTool: "gemini" }, ctx({ profiles }));
    expect(gemini).toMatchObject({ kind: "systemDefault", credential: { kind: "cli" }, model: null });
  });

  it("chat: empty id is the system default (no fallback to isDefault)", () => {
    const profiles = [profile({ isDefault: true })];
    expect(describeLaunchProfile({}, ctx({ profiles, mode: "chat" })).kind).toBe("systemDefault");
  });

  it("CLI login when no provider is injected; missing relay once providers are known", () => {
    expect(describeLaunchProfile({ cliTool: "claude", providerSelection: "none", providerId: "relay" }, ctx()).credential)
      .toEqual({ kind: "cli" });
    expect(describeLaunchProfile({ cliTool: "claude", providerId: "__system__" }, ctx()).credential)
      .toEqual({ kind: "cli" });
    expect(describeLaunchProfile({ cliTool: "claude", providerId: "nope" }, ctx()).credential)
      .toEqual({ kind: "missingRelay" });
    expect(describeLaunchProfile({ cliTool: "claude", providerId: "nope" }, ctx({ providers: [] })).credential)
      .toBeNull();
  });
});
