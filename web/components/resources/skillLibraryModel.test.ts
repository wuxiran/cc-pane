import { describe, expect, it } from "vitest";
import type { LibrarySkill, SkillCheck } from "@/types/skillLibrary";
import {
  builtinSkillRows,
  AUTO_CHECK_INTERVAL_MS,
  autoCheckDue,
  defaultProbePicks,
  filterLibrarySkills,
  groupLibrarySkills,
  planBulkUpdate,
  skillSourceText,
  skillStatusTags,
} from "./skillLibraryModel";

function skill(id: string, over: Partial<LibrarySkill> = {}): LibrarySkill {
  return {
    id,
    name: id,
    provenance: { kind: "github", repo: "anthropics/skills", path: `skills/${id}` },
    edited: "no",
    gone: false,
    folderMissing: false,
    dirPath: `/data/skills/user/${id}`,
    installedAt: "2026-11-01T00:00:00Z",
    ...over,
  };
}
const check = (id: string, status: SkillCheck["status"], over: Partial<SkillCheck> = {}): SkillCheck => ({ id, status, ...over });

describe("groupLibrarySkills", () => {
  it("groups GitHub by owner/repo, git by address and everything else into one local group last", () => {
    const groups = groupLibrarySkills([
      skill("zeta", { provenance: { kind: "folder", linkedPath: "/Users/me/zeta" } }),
      skill("pdf"),
      skill("docx", { provenance: { kind: "github", repo: "Anthropics/Skills" } }),
      skill("lint", { provenance: { kind: "git", repo: "https://gitlab.com/team/tools.git" } }),
      skill("old", { provenance: { kind: "imported", importedFrom: "/Users/me/.claude/skills/old" } }),
      skill("mystery", { provenance: { kind: "unknown" } }),
    ]);
    expect(groups.map((group) => [group.kind, group.label, group.skills.map((item) => item.id)])).toEqual([
      ["github", "anthropics/skills", ["docx", "pdf"]],
      ["git", "gitlab.com/team/tools", ["lint"]],
      ["local", "", ["mystery", "old", "zeta"]],
    ]);
    expect(groups[0].url).toBe("https://github.com/anthropics/skills");
    expect(groups[1].url).toBe("https://gitlab.com/team/tools.git");
  });

  it("has no link for ssh git addresses", () => {
    const [group] = groupLibrarySkills([skill("a", { provenance: { kind: "git", repo: "git@host:team/repo.git" } })]);
    expect(group.label).toBe("git@host:team/repo");
    expect(group.url).toBeNull();
  });
});

describe("skillStatusTags", () => {
  it("shows gone instead of update, from either the persisted flag or the check", () => {
    expect(skillStatusTags(skill("a", { gone: true }), check("a", "update"))).toEqual(["gone"]);
    expect(skillStatusTags(skill("a"), check("a", "gone"))).toEqual(["gone"]);
  });

  it("adds edited and folder-missing beside the check result", () => {
    expect(skillStatusTags(skill("a", { edited: "yes" }), check("a", "update"))).toEqual(["update", "edited"]);
    expect(skillStatusTags(skill("a", { edited: "unknown" }))).toEqual([]);
    expect(skillStatusTags(skill("a", { provenance: { kind: "folder" }, folderMissing: true }))).toEqual(["folderMissing"]);
  });

  it("marks failed checks of tracked skills only; unsupported sources stay quiet", () => {
    expect(skillStatusTags(skill("a"), check("a", "unknown", { error: "rate limited" }))).toEqual(["unchecked"]);
    expect(skillStatusTags(skill("a", { provenance: { kind: "folder" } }), check("a", "unknown", { error: "unsupported" }))).toEqual([]);
    expect(skillStatusTags(skill("a"), check("a", "current"))).toEqual([]);
  });
});

describe("filterLibrarySkills", () => {
  const list = [skill("pdf", { description: "Read PDF files" }), skill("lint", { provenance: { kind: "git", repo: "https://gitlab.com/team/tools" } })];
  it("matches name, description and source", () => {
    expect(filterLibrarySkills(list, "  ").map((item) => item.id)).toEqual(["pdf", "lint"]);
    expect(filterLibrarySkills(list, "PDF FILES").map((item) => item.id)).toEqual(["pdf"]);
    expect(filterLibrarySkills(list, "gitlab").map((item) => item.id)).toEqual(["lint"]);
  });
  it("shows the folder for local sources", () => {
    expect(skillSourceText(skill("x", { provenance: { kind: "folder", linkedPath: "/a/b" } }))).toBe("/a/b");
  });
});

describe("planBulkUpdate", () => {
  it("updates clean skills with updates, skips edited and unknown ones by name, ignores gone and current", () => {
    const skills = [
      skill("clean"),
      skill("mine", { edited: "yes", name: "Mine" }),
      skill("old", { edited: "unknown", name: "Old" }),
      skill("gone", { gone: true }),
      skill("same"),
    ];
    const checks = {
      clean: check("clean", "update"),
      mine: check("mine", "update"),
      old: check("old", "update"),
      gone: check("gone", "update"),
      same: check("same", "current"),
    };
    expect(planBulkUpdate(skills, checks)).toEqual({ ids: ["clean"], skippedNames: ["Mine", "Old"] });
  });
});

describe("autoCheckDue", () => {
  const now = 1_800_000_000_000;
  it("is due when never checked or the record is broken", () => {
    expect(autoCheckDue(null, now)).toBe(true);
    expect(autoCheckDue(Number.NaN, now)).toBe(true);
  });
  it("waits 12 hours between automatic checks", () => {
    expect(autoCheckDue(now - AUTO_CHECK_INTERVAL_MS + 1000, now)).toBe(false);
    expect(autoCheckDue(now - AUTO_CHECK_INTERVAL_MS, now)).toBe(true);
  });
  it("is due when the clock went backwards", () => {
    expect(autoCheckDue(now + 60_000, now)).toBe(true);
  });
});

describe("defaultProbePicks", () => {
  it("picks every new candidate when there are at most three", () => {
    expect([...defaultProbePicks([{ path: "a", have: false }, { path: "b", have: true }, { path: "c", have: false }])]).toEqual(["a", "c"]);
  });
  it("picks nothing when there are more", () => {
    const many = ["a", "b", "c", "d"].map((path) => ({ path, have: false }));
    expect(defaultProbePicks(many).size).toBe(0);
  });
});

describe("builtinSkillRows", () => {
  it("keeps the core order and appends every other bundled skill with the policy prefix", () => {
    const rows = builtinSkillRows(
      [{ name: "launch-task" }, { name: "recall" }, { name: "admin" }, { name: "ccpanes-finish-work" }],
      ["ccpanes-launch-task", "ccpanes-admin"],
    );
    expect(rows).toEqual(["ccpanes-launch-task", "ccpanes-admin", "ccpanes-finish-work", "ccpanes-recall"]);
  });

  it("still lists the core skills before the bundled list loads", () => {
    expect(builtinSkillRows([], ["ccpanes-launch-task"])).toEqual(["ccpanes-launch-task"]);
  });
});
