import { describe, expect, it } from "vitest";
import { defaultLaunchProfileDraft } from "@/types/launch-profile";
import type { LaunchProfileDraft } from "@/types";
import { isBuiltinSkillSelected, isSharedMcpServerSelected, isUserSkillSelected } from "./launchProfileHelpers";
import { nextSetSharedMcp, nextSetSkill, pendingAdditions } from "./launchProfileAddModel";

function draftWith(mcp: Partial<LaunchProfileDraft["mcpPolicy"]> = {}, skill: Partial<LaunchProfileDraft["skillPolicy"]> = {}): LaunchProfileDraft {
  const base = defaultLaunchProfileDraft();
  return { ...base, mcpPolicy: { ...base.mcpPolicy, ...mcp }, skillPolicy: { ...base.skillPolicy, ...skill } };
}

describe("nextSetSharedMcp", () => {
  const all = ["a", "b", "c"];

  it("默认组合下重新开启被排除的 server", () => {
    const next = nextSetSharedMcp(draftWith({ disabledServerIds: ["b"] }), "b", true, all);
    expect(isSharedMcpServerSelected(next.mcpPolicy, "b")).toBe(true);
  });

  it("自定义选择下加入 enabledServerIds", () => {
    const next = nextSetSharedMcp(draftWith({ mode: "custom", enabledServerIds: ["a"] }), "c", true, all);
    expect(next.mcpPolicy.enabledServerIds).toEqual(["a", "c"]);
  });

  it("共享总开关关着时只放进选中的这一个，不把整个共享池带进来", () => {
    const next = nextSetSharedMcp(draftWith({ includeSharedMcp: false }), "b", true, all);
    expect(next.mcpPolicy.includeSharedMcp).toBe(true);
    expect(isSharedMcpServerSelected(next.mcpPolicy, "b")).toBe(true);
    expect(isSharedMcpServerSelected(next.mcpPolicy, "a")).toBe(false);
    expect(isSharedMcpServerSelected(next.mcpPolicy, "c")).toBe(false);
  });

  it("不注入模式下不改动", () => {
    const draft = draftWith({ mode: "disabled" });
    expect(nextSetSharedMcp(draft, "a", true, all)).toBe(draft);
  });

  it("可以取消勾选", () => {
    const next = nextSetSharedMcp(draftWith(), "a", false, all);
    expect(isSharedMcpServerSelected(next.mcpPolicy, "a")).toBe(false);
  });
});

describe("nextSetSkill", () => {
  it("资源库技能写进 user:<id>，不改模式", () => {
    const next = nextSetSkill(draftWith(), { kind: "user", id: "s1" }, true);
    expect(isUserSkillSelected(next.skillPolicy, "s1")).toBe(true);
    expect(next.skillPolicy.mode).toBe("core");
  });

  it("内置技能可以关掉再打开", () => {
    const off = nextSetSkill(draftWith(), { kind: "builtin", name: "ccpanes-admin" }, false);
    expect(isBuiltinSkillSelected(off.skillPolicy, "ccpanes-admin")).toBe(false);
    const on = nextSetSkill(off, { kind: "builtin", name: "ccpanes-admin" }, true);
    expect(isBuiltinSkillSelected(on.skillPolicy, "ccpanes-admin")).toBe(true);
  });

  it("Skill 不注入时不改动", () => {
    const draft = draftWith({}, { mode: "disabled" });
    expect(nextSetSkill(draft, { kind: "user", id: "s1" }, true)).toBe(draft);
  });
});

describe("pendingAdditions", () => {
  it("只返回预览里还没有的", () => {
    expect(pendingAdditions(["a", "b"], [{ name: "a" }])).toEqual(["b"]);
  });

  it("预览未就绪时不报新增", () => {
    expect(pendingAdditions(["a"], null)).toEqual([]);
  });
});
