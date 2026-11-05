import { describe, expect, it } from "vitest";
import type { LaunchProfile, LaunchProfileDraft } from "@/types";
import { setSkillResource, skillChipState, type ProfileSkillResource } from "./resourceCenterModel";

type SkillPolicy = LaunchProfile["skillPolicy"];

const policy = (over: Partial<SkillPolicy> = {}): SkillPolicy => ({
  mode: "core",
  enabledSkillIds: [],
  disabledSkillIds: [],
  profileSkills: [],
  includeProjectSkills: false,
  includeExternalClaudeSkills: true,
  includeExternalCodexSkills: true,
  includeExternalPluginSkills: true,
  target: "session",
  ...over,
});
const draft = (skillPolicy: SkillPolicy) => ({ skillPolicy }) as LaunchProfileDraft;
const user: ProfileSkillResource = { kind: "user", id: "pdf" };
const builtin: ProfileSkillResource = { kind: "builtin", name: "ccpanes-admin" };
const workspaceGroup: ProfileSkillResource = { kind: "group", key: "includeWorkspaceSkills" };

describe("skillChipState", () => {
  it("blocks everything with a reason when the profile turned skills off", () => {
    for (const resource of [user, builtin, workspaceGroup]) {
      expect(skillChipState(policy({ mode: "disabled", enabledSkillIds: ["user:pdf"] }), resource)).toEqual({ on: false, blocked: "skillsDisabled" });
    }
  });

  it("reads user skills from the enabled list in any mode", () => {
    expect(skillChipState(policy(), user).on).toBe(false);
    expect(skillChipState(policy({ enabledSkillIds: ["user:pdf"] }), user).on).toBe(true);
    expect(skillChipState(policy({ mode: "custom", enabledSkillIds: ["user:pdf"] }), user).on).toBe(true);
  });

  it("reads builtins from the disabled list in core mode and the enabled list in custom mode", () => {
    expect(skillChipState(policy(), builtin).on).toBe(true);
    expect(skillChipState(policy({ disabledSkillIds: ["builtin:ccpanes-admin"] }), builtin).on).toBe(false);
    expect(skillChipState(policy({ mode: "custom" }), builtin).on).toBe(false);
    expect(skillChipState(policy({ mode: "custom", enabledSkillIds: ["builtin:ccpanes-admin"] }), builtin).on).toBe(true);
  });

  it("treats a missing workspace flag as on, like old profiles", () => {
    expect(skillChipState(policy(), workspaceGroup).on).toBe(true);
    expect(skillChipState(policy({ includeWorkspaceSkills: false }), workspaceGroup).on).toBe(false);
    expect(skillChipState(policy({ includeExternalCodexSkills: false }), { kind: "group", key: "includeExternalCodexSkills" }).on).toBe(false);
  });
});

describe("setSkillResource", () => {
  it("adds and removes user:<id> without changing the mode", () => {
    const on = setSkillResource(draft(policy({ disabledSkillIds: ["user:pdf"] })), user, true);
    expect(on.skillPolicy.mode).toBe("core");
    expect(on.skillPolicy.enabledSkillIds).toEqual(["user:pdf"]);
    expect(on.skillPolicy.disabledSkillIds).toEqual([]);
    const off = setSkillResource(on, user, false);
    expect(off.skillPolicy.mode).toBe("core");
    expect(off.skillPolicy.enabledSkillIds).toEqual([]);
  });

  it("is idempotent", () => {
    const on = setSkillResource(draft(policy()), user, true);
    expect(setSkillResource(on, user, true)).toBe(on);
  });

  it("flips the disabled list for builtins in core mode and keeps core", () => {
    const off = setSkillResource(draft(policy()), builtin, false);
    expect(off.skillPolicy.mode).toBe("core");
    expect(off.skillPolicy.disabledSkillIds).toEqual(["builtin:ccpanes-admin"]);
    expect(setSkillResource(off, builtin, true).skillPolicy.disabledSkillIds).toEqual([]);
  });

  it("flips the enabled list for builtins in custom mode", () => {
    const on = setSkillResource(draft(policy({ mode: "custom" })), builtin, true);
    expect(on.skillPolicy).toMatchObject({ mode: "custom", enabledSkillIds: ["builtin:ccpanes-admin"] });
  });

  it("sets group flags directly", () => {
    const off = setSkillResource(draft(policy()), workspaceGroup, false);
    expect(off.skillPolicy.includeWorkspaceSkills).toBe(false);
    expect(setSkillResource(off, workspaceGroup, true).skillPolicy.includeWorkspaceSkills).toBe(true);
  });

  it("never changes a profile with skills turned off", () => {
    const disabled = draft(policy({ mode: "disabled" }));
    expect(setSkillResource(disabled, user, true)).toBe(disabled);
    expect(setSkillResource(disabled, builtin, false)).toBe(disabled);
  });
});
