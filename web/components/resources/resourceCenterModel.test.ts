import { describe, expect, it } from "vitest";
import type { LaunchProfile, LaunchProfileDraft } from "@/types";
import {
  allChipState,
  mcpChipState,
  mcpStatusOf,
  nextSharedPorts,
  pasteRowProblem,
  setMcpResource,
  visibleProfiles,
} from "./resourceCenterModel";

const policy = (over: Partial<LaunchProfile["mcpPolicy"]> = {}): LaunchProfile["mcpPolicy"] => ({
  mode: "default",
  enabledServerIds: [],
  disabledServerIds: [],
  includeCcpanesMcp: true,
  includeSharedMcp: true,
  ...over,
});
const draft = (mcpPolicy: LaunchProfile["mcpPolicy"]) => ({ mcpPolicy }) as LaunchProfileDraft;
const github = { kind: "shared", name: "github" } as const;

describe("mcpChipState", () => {
  it("blocks every resource when the profile turned MCP off", () => {
    expect(mcpChipState(policy({ mode: "disabled" }), github)).toEqual({ on: false, blocked: "mcpDisabled" });
    expect(mcpChipState(policy({ mode: "disabled" }), { kind: "ccpanes" })).toEqual({ on: false, blocked: "mcpDisabled" });
  });

  it("blocks shared servers when the profile doesn't use shared MCP, but not ccpanes", () => {
    const off = policy({ includeSharedMcp: false });
    expect(mcpChipState(off, github).blocked).toBe("sharedOff");
    expect(mcpChipState(off, { kind: "ccpanes" })).toEqual({ on: true, blocked: null });
  });

  it("reads default mode from the disabled list and custom mode from the enabled list", () => {
    expect(mcpChipState(policy(), github).on).toBe(true);
    expect(mcpChipState(policy({ disabledServerIds: ["github"] }), github).on).toBe(false);
    expect(mcpChipState(policy({ mode: "custom" }), github).on).toBe(false);
    expect(mcpChipState(policy({ mode: "custom", enabledServerIds: ["github"] }), github).on).toBe(true);
  });
});

describe("setMcpResource", () => {
  it("is idempotent, so repeated clicks and All can't flip it back", () => {
    const once = setMcpResource(draft(policy()), github, false);
    expect(once.mcpPolicy.disabledServerIds).toEqual(["github"]);
    expect(setMcpResource(once, github, false)).toBe(once);
  });

  it("writes the enabled list in custom mode and keeps the mode", () => {
    const next = setMcpResource(draft(policy({ mode: "custom" })), github, true);
    expect(next.mcpPolicy.mode).toBe("custom");
    expect(next.mcpPolicy.enabledServerIds).toEqual(["github"]);
  });

  it("never changes a blocked profile", () => {
    const off = draft(policy({ mode: "disabled" }));
    expect(setMcpResource(off, github, true)).toBe(off);
  });

  it("toggles the built-in server through its own field", () => {
    const next = setMcpResource(draft(policy()), { kind: "ccpanes" }, false);
    expect(next.mcpPolicy.includeCcpanesMcp).toBe(false);
  });
});

describe("allChipState", () => {
  const on = { on: true, blocked: null };
  const off = { on: false, blocked: null };
  const blocked = { on: false, blocked: "mcpDisabled" } as const;

  it("ignores blocked profiles", () => {
    expect(allChipState([on, on, blocked])).toEqual({ available: true, on: true });
    expect(allChipState([on, off, blocked])).toEqual({ available: true, on: false });
  });

  it("is unavailable with fewer than two usable profiles", () => {
    expect(allChipState([on, blocked]).available).toBe(false);
  });
});

describe("mcpStatusOf", () => {
  it("carries the failure reason", () => {
    expect(mcpStatusOf({ failed: { message: "Exited: 1" } })).toEqual({ level: "failed", reason: "Exited: 1" });
    expect(mcpStatusOf("running")).toEqual({ level: "running", reason: null });
  });
});

describe("visibleProfiles", () => {
  const p = (id: string, isDefault = false) => ({ id, isDefault }) as LaunchProfile;

  it("puts the default first and caps the list", () => {
    expect(visibleProfiles([p("a"), p("b", true), p("c")], null, 2).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("honours the user's choice and ignores deleted profiles", () => {
    expect(visibleProfiles([p("a"), p("b")], ["b", "gone"]).map((x) => x.id)).toEqual(["b"]);
  });

  it("falls back when every chosen profile is gone", () => {
    expect(visibleProfiles([p("a")], ["gone"]).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("pasteRowProblem", () => {
  it("names what stops a row from being added", () => {
    const names = new Set(["taken"]);
    expect(pasteRowProblem({ name: "r", url: "https://x" }, names)).toBe("remote");
    expect(pasteRowProblem({ name: "" }, names)).toBe("noName");
    expect(pasteRowProblem({ name: "taken" }, names)).toBe("exists");
    expect(pasteRowProblem({ name: "free" }, names)).toBeNull();
  });
});

describe("nextSharedPorts", () => {
  it("skips used ports and gives each server its own", () => {
    expect(nextSharedPorts([10, 12], 2, { start: 10, end: 20 })).toEqual([11, 13]);
  });

  it("throws rather than leave the range", () => {
    expect(() => nextSharedPorts([10], 2, { start: 10, end: 11 })).toThrow();
  });
});
