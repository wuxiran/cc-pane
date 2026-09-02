// 项目 Agent Skills 面板的纯函数：分组、根目录选择、名称校验、CLI 徽章。
// 与后端 project_skill_service 的规则保持一致（名称字符集、根目录清单来自后端）。
import { WORKSPACE_SKILL_ROOT, type ProjectSkill, type ProjectSkillRoot } from "@/types";

/** 后端根目录列表不可用时的兜底（与 PROJECT_SKILL_ROOTS 同步） */
export const FALLBACK_ROOTS: ProjectSkillRoot[] = [
  { root: ".agents/skills", consumers: ["codex", "cursor"], recommended: true },
  { root: ".claude/skills", consumers: ["claude", "cursor"], recommended: true },
  { root: ".cursor/skills", consumers: ["cursor"], recommended: false },
  { root: ".codex/skills", consumers: ["cursor"], recommended: false },
  { root: ".gemini/skills", consumers: ["gemini"], recommended: false },
];

/**
 * 工作空间技能的虚拟根：单一目录 `<workspace>/skills`，Claude/Codex 原生挂载；
 * 其他 CLI 通过 session prompt 注入（面板文案另行说明）。
 */
export const WORKSPACE_VIRTUAL_ROOT: ProjectSkillRoot = {
  root: WORKSPACE_SKILL_ROOT,
  consumers: ["claude", "codex"],
  recommended: true,
};

/** CLI id → 身份色 token（复用 --app-cli-* 调色） */
export const CONSUMER_TOKEN: Record<string, string> = {
  claude: "var(--app-cli-claude)",
  codex: "var(--app-cli-codex)",
  cursor: "var(--app-cli-cursor)",
  gemini: "var(--app-cli-gemini)",
};

export interface RootGroup {
  root: ProjectSkillRoot;
  skills: ProjectSkill[];
}

/** 按根目录分组，保持后端根顺序；只返回有技能的根 */
export function groupByRoot(skills: readonly ProjectSkill[], roots: readonly ProjectSkillRoot[]): RootGroup[] {
  const known = roots.length > 0 ? roots : FALLBACK_ROOTS;
  const groups: RootGroup[] = known.map((root) => ({ root, skills: [] }));
  const byRoot = new Map(groups.map((group) => [group.root.root, group]));
  for (const skill of skills) {
    const group = byRoot.get(skill.root);
    if (group) group.skills.push(skill);
  }
  return groups.filter((group) => group.skills.length > 0);
}

/** 新建/导入时的默认根：优先 Claude（CC-Panes 主 CLI），其次第一个推荐根 */
export function defaultRoot(roots: readonly ProjectSkillRoot[]): string {
  const known = roots.length > 0 ? roots : FALLBACK_ROOTS;
  return (
    known.find((root) => root.root === ".claude/skills")?.root ??
    known.find((root) => root.recommended)?.root ??
    known[0].root
  );
}

/** 与后端 validate_skill_name 同规则：小写字母/数字/-/_，≤64，不以 . 开头 */
export function validateSkillName(name: string): "ok" | "empty" | "invalid" {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (trimmed.length > 64 || trimmed.startsWith(".") || !/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
    return "invalid";
  }
  return "ok";
}

/** 把任意展示名压成合法技能名：空格/大写/非法字符 → '-' */
export function suggestSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
}

/** 一个技能对多少 CLI 可见（合并同名技能跨根目录的情况） */
export function consumersFor(skill: ProjectSkill, roots: readonly ProjectSkillRoot[]): string[] {
  const known = roots.length > 0 ? roots : FALLBACK_ROOTS;
  const root = known.find((candidate) => candidate.root === skill.root);
  return root ? root.consumers : skill.consumers;
}

/** 可移动的目标根（排除当前根） */
export function moveTargets(skill: ProjectSkill, roots: readonly ProjectSkillRoot[]): ProjectSkillRoot[] {
  const known = roots.length > 0 ? roots : FALLBACK_ROOTS;
  return known.filter((root) => root.root !== skill.root);
}
