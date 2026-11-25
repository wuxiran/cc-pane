import { describe, expect, it } from "vitest";
import type { LaunchProfile } from "@/types/launch-profile";
import type { Provider } from "@/types/provider";
import { describeLaunchProfile } from "./launchProfileDisplay";
import { buildLaunchProfileSnapshot, launchProfileIdForLaunch } from "./launchProfileSnapshot";

function profile(overrides: Partial<LaunchProfile>): LaunchProfile {
  return { id: "p1", name: "工作", targetTools: [], isDefault: false, ...overrides } as unknown as LaunchProfile;
}

const relay: Provider = {
  id: "relay",
  name: "Magpie",
  providerType: "anthropic",
  isDefault: false,
  defaultModelId: "group/code",
  accounts: [{ id: "k1", name: "主密钥", kind: "api_key" }],
};

const now = () => new Date("2026-11-25T00:00:00.000Z");
const work = profile({ id: "p-work", name: "工作", providerId: "relay", modelId: "opus" });
const defaultCodex = profile({ id: "p-codex", name: "Codex 默认", targetTools: ["codex"], isDefault: true });
const defaultAll = profile({ id: "p-default", name: "通用默认", isDefault: true });

describe("buildLaunchProfileSnapshot", () => {
  it("records the named profile with its credential and model", () => {
    const snapshot = buildLaunchProfileSnapshot(
      { launchProfileId: "p-work", cliTool: "claude" },
      { profiles: [work, defaultAll], providers: [relay], mode: "terminal", now },
    );
    expect(snapshot).toEqual({
      launchProfileId: "p-work",
      name: "工作",
      credential: { kind: "relay", name: "Magpie" },
      model: "opus",
      capturedAt: "2026-11-25T00:00:00.000Z",
    });
  });

  it("falls back to the CLI's default profile and marks it implicit", () => {
    const snapshot = buildLaunchProfileSnapshot(
      { cliTool: "codex" },
      { profiles: [defaultAll, defaultCodex].reverse(), providers: [], mode: "terminal", now },
    );
    expect(snapshot.launchProfileId).toBe("p-codex");
    expect(snapshot.implicitDefault).toBe(true);
    expect(snapshot.credential).toEqual({ kind: "cli" });
  });

  it("a named profile that does not target the CLI falls back like the backend", () => {
    const codexOnly = profile({ id: "p-x", targetTools: ["codex"] });
    const snapshot = buildLaunchProfileSnapshot(
      { launchProfileId: "p-x", cliTool: "claude" },
      { profiles: [codexOnly, defaultAll], providers: [], mode: "terminal", now },
    );
    expect(snapshot).toMatchObject({ launchProfileId: "p-default", implicitDefault: true });
  });

  it("uses the workspace-bound profile when the launch did not name one", () => {
    const snapshot = buildLaunchProfileSnapshot(
      { cliTool: "claude", workspaceLaunchProfileId: "p-work" },
      { profiles: [work, defaultAll], providers: [relay], mode: "terminal", now },
    );
    expect(snapshot.launchProfileId).toBe("p-work");
    expect(snapshot.implicitDefault).toBeUndefined();
  });

  it("no profile at all = system default (null id)", () => {
    const snapshot = buildLaunchProfileSnapshot({ cliTool: "claude" }, { profiles: [], providers: [], mode: "terminal", now });
    expect(snapshot).toMatchObject({ launchProfileId: null, model: null, credential: { kind: "cli" } });
  });

  it("chat never falls back to the default profile", () => {
    const snapshot = buildLaunchProfileSnapshot({}, { profiles: [defaultAll], providers: [], mode: "chat", now });
    expect(snapshot.launchProfileId).toBeNull();
  });

  it("leaves credential out when providers are not known yet (display falls back to live data)", () => {
    const snapshot = buildLaunchProfileSnapshot(
      { launchProfileId: "p-work", cliTool: "claude" },
      { profiles: [work], providers: [], mode: "terminal", now },
    );
    expect(snapshot).not.toHaveProperty("credential");
  });
});

describe("launchProfileIdForLaunch", () => {
  it("prefers the named id, then the snapshot's resolved id", () => {
    const snapshot = { launchProfileId: "p-old", model: null, capturedAt: "" };
    expect(launchProfileIdForLaunch({ launchProfileId: "p-named", launchProfileSnapshot: snapshot })).toBe("p-named");
    expect(launchProfileIdForLaunch({ launchProfileSnapshot: snapshot })).toBe("p-old");
    expect(launchProfileIdForLaunch({ launchProfileSnapshot: { ...snapshot, launchProfileId: null } })).toBeUndefined();
    expect(launchProfileIdForLaunch({})).toBeUndefined();
  });
});

describe("describeLaunchProfile with a launch snapshot", () => {
  const snapshot = {
    launchProfileId: "p-work",
    name: "工作（旧名）",
    credential: { kind: "login" as const, name: "me@example.com" },
    model: "sonnet",
    capturedAt: "2026-11-25T00:00:00.000Z",
  };
  const ctx = { providers: [relay], mode: "terminal" as const };

  it("live profile: current name, snapshot credential and model", () => {
    const display = describeLaunchProfile(
      { cliTool: "claude", launchProfileSnapshot: snapshot },
      { ...ctx, profiles: [{ ...work, alias: "新名字" }], profilesLoaded: true },
    );
    expect(display).toEqual({
      kind: "profile",
      name: "新名字",
      credential: { kind: "login", name: "me@example.com" },
      model: "sonnet",
    });
  });

  it("deleted profile keeps the original name", () => {
    const display = describeLaunchProfile(
      { cliTool: "claude", launchProfileSnapshot: snapshot },
      { ...ctx, profiles: [], profilesLoaded: true },
    );
    expect(display).toMatchObject({ kind: "deleted", name: "工作（旧名）", model: "sonnet" });
  });

  it("does not claim deletion before profiles load", () => {
    const display = describeLaunchProfile(
      { cliTool: "claude", launchProfileSnapshot: snapshot },
      { ...ctx, profiles: [], profilesLoaded: false },
    );
    expect(display).toMatchObject({ kind: "profile", name: "工作（旧名）" });
  });

  it("snapshot wins over a default profile that changed after launch", () => {
    const display = describeLaunchProfile(
      { cliTool: "claude", launchProfileSnapshot: { ...snapshot, launchProfileId: null, name: undefined } },
      { ...ctx, profiles: [defaultAll], profilesLoaded: true },
    );
    expect(display.kind).toBe("systemDefault");
  });

  it("implicit default snapshot stays labelled as the default profile", () => {
    const display = describeLaunchProfile(
      { cliTool: "claude", launchProfileSnapshot: { ...snapshot, launchProfileId: "p-default", implicitDefault: true } },
      { ...ctx, profiles: [defaultAll], profilesLoaded: true },
    );
    expect(display).toMatchObject({ kind: "implicitDefault", name: "通用默认" });
  });

  it("old data without a snapshot keeps the fallback logic", () => {
    const display = describeLaunchProfile(
      { cliTool: "claude" },
      { ...ctx, profiles: [defaultAll], profilesLoaded: true },
    );
    expect(display).toMatchObject({ kind: "implicitDefault", name: "通用默认" });
  });
});
