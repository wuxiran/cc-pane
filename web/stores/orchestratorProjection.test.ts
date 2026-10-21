import { describe, expect, it } from "vitest";
import type { TaskBinding } from "@/types";
import { activeQuery, matchesQuery, normalizePlanPath } from "./orchestratorProjection";
import { useOrchestratorStore } from "./useOrchestratorStore";
const row: TaskBinding = { id: "row", title: "Build ABC", prompt: "separate column", projectPath: "/repo", status: "running", role: "worker", cliTool: "claude", sortOrder: 0, progress: 0, createdAt: "now", updatedAt: "now" };
describe("orchestrator query parity", () => {
  it("matches SQLite LIKE per column, including ASCII case and wildcard semantics", () => {
    expect(matchesQuery(row, { search: "build a_" })).toBe(true);
    expect(matchesQuery({ ...row, title: "x💡y" }, { search: "x_y" })).toBe(true);
    expect(matchesQuery(row, { search: "b%abc" })).toBe(true);
    expect(matchesQuery(row, { search: "ABC separate" })).toBe(false);
    expect(matchesQuery({ ...row, title: "É" }, { search: "é" })).toBe(false);
    expect(matchesQuery({ ...row, title: "a.b" }, { search: "a.b" })).toBe(true);
    expect(matchesQuery({ ...row, title: "axb" }, { search: "a.b" })).toBe(false);
  });
  it("honors legacy child roles and all explicit active-query fields", () => {
    expect(matchesQuery({ ...row, role: "child" as never }, { role: "worker" })).toBe(true);
    const state = { ...useOrchestratorStore.getInitialState(), queryOverrides: { status: "running" as const, parentId: "parent", sessionId: "session", planPath: "D:\\Plans\\Work.md" } };
    const query = activeQuery(state);
    expect(query).toEqual({ status: "running", parentId: "parent", sessionId: "session", normalizedPlanPath: "d:/plans/work.md" });
    expect(matchesQuery({ ...row, parentId: "parent", sessionId: "session", normalizedPlanPath: "d:/plans/work.md" }, query)).toBe(true);
    expect(matchesQuery(row, query)).toBe(false);
  });
  // Mirrors normalize_plan_path's Rust examples; the extra WSL host/wrapper cases
  // share parseWslUnc instead of maintaining a second incomplete UNC parser.
  it.each([
    ["D:\\repo\\.claude\\plans\\Plan.md", "d:/repo/.claude/plans/plan.md"],
    ["/mnt/d/repo/.claude/plans/Plan.md", "d:/repo/.claude/plans/plan.md"],
    ["\\\\wsl.localhost\\Ubuntu\\mnt\\d\\repo\\.claude\\plans\\Plan.md", "d:/repo/.claude/plans/plan.md"],
    ["\\\\wsl$\\Ubuntu\\mnt\\D\\repo\\.claude\\plans\\Plan.md", "d:/repo/.claude/plans/plan.md"],
    ["\\\\wsl\\Ubuntu\\mnt\\D\\repo\\.claude\\plans\\Plan.md", "d:/repo/.claude/plans/plan.md"],
    ["\\\\?\\UNC\\wsl\\Ubuntu\\mnt\\d\\repo\\.claude\\plans\\Plan.md", "d:/repo/.claude/plans/plan.md"],
    ["\\\\?\\D:\\repo\\.claude\\plans\\Plan.md", "d:/repo/.claude/plans/plan.md"],
    ["/home/u/mnt/a/foo/plan.md", "/home/u/mnt/a/foo/plan.md"],
    ["D:\\work\\mnt\\c\\plan.md", "d:/work/mnt/c/plan.md"],
    ["\\\\wsl.localhost\\Ubuntu\\home\\u\\mnt\\a\\Plan.md", "/wsl.localhost/Ubuntu/home/u/mnt/a/Plan.md"],
    ["/home/User/repo/.claude/plans/Plan.md/", "/home/User/repo/.claude/plans/Plan.md"],
    ["\\\\wsl.localhost\\Ubuntu\\home\\User\\Plan.md", "/wsl.localhost/Ubuntu/home/User/Plan.md"],
    ["/mnt/d", "/mnt/d"],
  ])("normalizes %s like the backend", (path, expected) => expect(normalizePlanPath(path)).toBe(expected));
});
