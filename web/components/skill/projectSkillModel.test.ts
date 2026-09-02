import { describe, expect, it } from "vitest";
import type { ProjectSkill, ProjectSkillRoot } from "@/types";
import {
  FALLBACK_ROOTS,
  consumersFor,
  defaultRoot,
  groupByRoot,
  moveTargets,
  suggestSkillName,
  validateSkillName,
} from "./projectSkillModel";

function skill(root: string, name: string): ProjectSkill {
  return {
    id: `${root}::${name}`,
    name,
    root,
    relDir: name,
    dirPath: `/p/${root}/${name}`,
    skillMdPath: `/p/${root}/${name}/SKILL.md`,
    fileCount: 1,
    hasScripts: false,
    consumers: [],
  };
}

describe("projectSkillModel", () => {
  it("groupByRoot 按后端根顺序分组并丢弃空根", () => {
    const skills = [skill(".cursor/skills", "b"), skill(".agents/skills", "a"), skill("weird", "x")];
    const groups = groupByRoot(skills, FALLBACK_ROOTS);
    expect(groups.map((g) => g.root.root)).toEqual([".agents/skills", ".cursor/skills"]);
    expect(groups[1].skills[0].name).toBe("b");
  });

  it("defaultRoot 优先 .claude/skills，其次推荐根，再兜底首个", () => {
    expect(defaultRoot(FALLBACK_ROOTS)).toBe(".claude/skills");
    const noClaude: ProjectSkillRoot[] = [
      { root: ".cursor/skills", consumers: ["cursor"], recommended: false },
      { root: ".agents/skills", consumers: ["codex"], recommended: true },
    ];
    expect(defaultRoot(noClaude)).toBe(".agents/skills");
    expect(defaultRoot([{ root: ".gemini/skills", consumers: ["gemini"], recommended: false }])).toBe(".gemini/skills");
    expect(defaultRoot([])).toBe(".claude/skills");
  });

  it("validateSkillName 与后端规则一致", () => {
    expect(validateSkillName("pdf-tools_2")).toBe("ok");
    expect(validateSkillName("  ")).toBe("empty");
    expect(validateSkillName("Has Space")).toBe("invalid");
    expect(validateSkillName("UPPER")).toBe("invalid");
    expect(validateSkillName(".hidden")).toBe("invalid");
    expect(validateSkillName("-lead")).toBe("invalid");
    expect(validateSkillName("a".repeat(65))).toBe("invalid");
  });

  it("suggestSkillName 把展示名压成合法名", () => {
    expect(suggestSkillName("Obsidian Markdown")).toBe("obsidian-markdown");
    expect(suggestSkillName("  小红书 文案 ")).toBe("");
    expect(suggestSkillName("web--design__guide!!")).toBe("web-design__guide");
    expect(validateSkillName(suggestSkillName("Deep Research 2.0"))).toBe("ok");
  });

  it("consumersFor 以根目录定义为准，moveTargets 排除当前根", () => {
    const s = skill(".claude/skills", "pdf");
    expect(consumersFor(s, FALLBACK_ROOTS)).toEqual(["claude", "cursor"]);
    expect(moveTargets(s, FALLBACK_ROOTS).map((r) => r.root)).not.toContain(".claude/skills");
    expect(moveTargets(s, FALLBACK_ROOTS)).toHaveLength(FALLBACK_ROOTS.length - 1);
  });
});
