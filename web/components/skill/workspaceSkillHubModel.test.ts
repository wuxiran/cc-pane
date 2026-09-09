import { describe, expect, it } from "vitest";
import type { BundledSkill, LaunchProfile, ProjectSkill, Workspace, WorkspaceProjectSkill } from "@/types";
import {
  filterBundledSkills,
  filterProjectSkills,
  filterWorkspaceSkills,
  groupProjectSkills,
  bundledPolicyName,
  hubTotalCount,
  matchesSkillQuery,
  projectLabel,
  resolveWorkspaceLaunchProfile,
} from "./workspaceSkillHubModel";

function skill(name: string, extra: Partial<ProjectSkill> = {}): ProjectSkill {
  return {
    id: `.claude/skills::${name}`,
    name,
    description: extra.description ?? null,
    root: extra.root ?? ".claude/skills",
    relDir: extra.relDir ?? name,
    dirPath: `/p/.claude/skills/${name}`,
    skillMdPath: `/p/.claude/skills/${name}/SKILL.md`,
    fileCount: 1,
    hasScripts: false,
    consumers: ["claude"],
    ...extra,
  };
}

function discovered(
  projectPath: string,
  name: string,
  alias?: string | null,
): WorkspaceProjectSkill {
  return {
    projectPath,
    projectAlias: alias,
    skill: skill(name, { dirPath: `${projectPath}/.claude/skills/${name}` }),
  };
}

describe("workspaceSkillHubModel", () => {
  it("matchesSkillQuery 忽略大小写，空查询全过", () => {
    expect(matchesSkillQuery(["PDF Tools", "Read files"], "pdf")).toBe(true);
    expect(matchesSkillQuery(["PDF Tools"], "xyz")).toBe(false);
    expect(matchesSkillQuery(["PDF"], "   ")).toBe(true);
  });

  it("三段过滤分别吃 name / description / 项目名", () => {
    expect(filterWorkspaceSkills([skill("pdf", { description: "Read docs" })], "docs")).toHaveLength(1);
    const launch: BundledSkill = {
      name: "ccpanes-launch-task",
      description: "Launch",
      descriptions: { "zh-CN": "启动任务", en: "Launch a task" },
    };
    expect(filterBundledSkills([launch], "launch")).toHaveLength(1);
    expect(filterBundledSkills([launch], "启动")).toHaveLength(1);
    expect(filterBundledSkills([launch], "xyz")).toHaveLength(0);
    const items = [
      discovered("D:/repos/alpha", "pdf", "Alpha"),
      discovered("D:/repos/beta", "deploy", "Beta"),
    ];
    expect(filterProjectSkills(items, "alpha").map((item) => item.skill.name)).toEqual(["pdf"]);
    expect(filterProjectSkills(items, "deploy").map((item) => item.skill.name)).toEqual(["deploy"]);
  });

  it("groupProjectSkills 按路径分组并用别名做标题", () => {
    const groups = groupProjectSkills([
      discovered("D:/repos/alpha", "pdf", "Alpha"),
      discovered("D:/repos/alpha", "lint", "Alpha"),
      discovered("D:/repos/beta", "deploy"),
    ]);
    expect(groups.map((group) => group.projectLabel)).toEqual(["Alpha", "beta"]);
    expect(groups[0].skills).toHaveLength(2);
  });

  it("projectLabel 无别名时取路径叶子", () => {
    expect(projectLabel({ projectPath: "D:\\repos\\cc-book", projectAlias: null })).toBe("cc-book");
  });

  it("resolveWorkspaceLaunchProfile 优先工作空间绑定，否则默认档", () => {
    const profiles = [
      { id: "a", name: "A", isDefault: false },
      { id: "b", name: "B", isDefault: true },
    ] as LaunchProfile[];
    expect(resolveWorkspaceLaunchProfile({ launchProfileId: "a" } as Workspace, profiles)?.id).toBe("a");
    expect(resolveWorkspaceLaunchProfile({} as Workspace, profiles)?.id).toBe("b");
    expect(resolveWorkspaceLaunchProfile(undefined, [])).toBeNull();
  });

  it("hubTotalCount 三段相加", () => {
    expect(hubTotalCount(1, 2, 3)).toBe(6);
  });

  it("bundledPolicyName 给清单名补上 ccpanes- 前缀", () => {
    expect(bundledPolicyName("launch-task")).toBe("ccpanes-launch-task");
    expect(bundledPolicyName("ccpanes-launch-task")).toBe("ccpanes-launch-task");
  });
});
