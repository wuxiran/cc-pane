// 工作空间 Skill 有效集页的纯函数：搜索、项目分组、启动档解析。
import type { BundledSkill, ProjectSkill, WorkspaceProjectSkill } from "@/types";

export function matchesSkillQuery(
  fields: Array<string | null | undefined>,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return fields.some((field) => (field ?? "").toLocaleLowerCase().includes(needle));
}

export function filterWorkspaceSkills(skills: readonly ProjectSkill[], query: string): ProjectSkill[] {
  return skills.filter((skill) =>
    matchesSkillQuery([skill.name, skill.description, skill.relDir], query),
  );
}

export function filterBundledSkills(skills: readonly BundledSkill[], query: string): BundledSkill[] {
  return skills.filter((skill) =>
    matchesSkillQuery(
      [skill.name, skill.description, ...Object.values(skill.descriptions ?? {})],
      query,
    ),
  );
}

export function filterProjectSkills(
  items: readonly WorkspaceProjectSkill[],
  query: string,
): WorkspaceProjectSkill[] {
  return items.filter((item) =>
    matchesSkillQuery(
      [item.skill.name, item.skill.description, item.skill.root, item.projectAlias, item.projectPath],
      query,
    ),
  );
}

export interface ProjectSkillGroup {
  projectPath: string;
  projectLabel: string;
  skills: WorkspaceProjectSkill[];
}

export function groupProjectSkills(items: readonly WorkspaceProjectSkill[]): ProjectSkillGroup[] {
  const groups: ProjectSkillGroup[] = [];
  const index = new Map<string, ProjectSkillGroup>();
  for (const item of items) {
    let group = index.get(item.projectPath);
    if (!group) {
      group = {
        projectPath: item.projectPath,
        projectLabel: projectLabel(item),
        skills: [],
      };
      index.set(item.projectPath, group);
      groups.push(group);
    }
    group.skills.push(item);
  }
  return groups;
}

export function projectLabel(item: Pick<WorkspaceProjectSkill, "projectPath" | "projectAlias">): string {
  const alias = item.projectAlias?.trim();
  if (alias) return alias;
  const normalized = item.projectPath.replace(/\\/g, "/");
  const leaf = normalized.split("/").filter(Boolean).pop();
  return leaf || item.projectPath;
}

export { resolveWorkspaceLaunchProfile } from "@/components/providers/launchProfileHelpers";

export function hubTotalCount(
  workspaceCount: number,
  bundledCount: number,
  projectCount: number,
): number {
  return workspaceCount + bundledCount + projectCount;
}

/** Launch-profile ids use `ccpanes-<manifestName>`; the market list uses the bare name. */
export function bundledPolicyName(name: string): string {
  return name.startsWith("ccpanes-") ? name : `ccpanes-${name}`;
}
