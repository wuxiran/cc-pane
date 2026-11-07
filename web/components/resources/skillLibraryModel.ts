// 技能页的纯函数层：按来源分组、状态标签、筛选、批量更新的分拣和自动检查的时机。
import { BUILTIN_SKILLS } from "@/components/providers/launchProfileHelpers";
import type { LibrarySkill, SkillCheck } from "@/types/skillLibrary";

export type SkillGroupKind = "github" | "git" | "local";

export interface LibrarySkillGroup {
  /** github:<owner/repo> / git:<地址> / local */
  key: string;
  kind: SkillGroupKind;
  /** github 为 owner/repo，git 为去掉协议的地址；本机组为空串，由界面给标题 */
  label: string;
  /** 能在浏览器里打开的仓库地址 */
  url: string | null;
  skills: LibrarySkill[];
}

/** 行内状态标签，对应 i18n `skillLibrary.tag.*` */
export type SkillStatusTag = "gone" | "update" | "unchecked" | "edited" | "folderMissing";

/** git 地址的显示形式：去掉 https:// 和末尾的 .git */
export function gitLabel(repo: string): string {
  return repo.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

function groupOf(skill: LibrarySkill): Omit<LibrarySkillGroup, "skills"> {
  const { kind, repo } = skill.provenance;
  if (kind === "github" && repo) {
    return { key: `github:${repo.toLowerCase()}`, kind: "github", label: repo, url: `https://github.com/${repo}` };
  }
  if (kind === "git" && repo) {
    const label = gitLabel(repo);
    return { key: `git:${label.toLowerCase()}`, kind: "git", label, url: /^https?:\/\//.test(repo) ? repo : null };
  }
  return { key: "local", kind: "local", label: "", url: null };
}

const GROUP_ORDER: Record<SkillGroupKind, number> = { github: 0, git: 1, local: 2 };

/** GitHub 按 owner/repo、git 按地址、其余（本机文件夹、导入、未知）合成一组放最后。 */
export function groupLibrarySkills(skills: readonly LibrarySkill[]): LibrarySkillGroup[] {
  const groups = new Map<string, LibrarySkillGroup>();
  for (const skill of skills) {
    const head = groupOf(skill);
    const group = groups.get(head.key) ?? { ...head, skills: [] };
    group.skills.push(skill);
    groups.set(head.key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, skills: [...group.skills].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind] || a.label.localeCompare(b.label));
}

/** 只有 github / git 来源能检查和更新 */
export function isTracked(skill: LibrarySkill): boolean {
  return skill.provenance.kind === "github" || skill.provenance.kind === "git";
}

export function isGone(skill: LibrarySkill, check?: SkillCheck): boolean {
  return skill.gone || check?.status === "gone";
}

/** 本地改动过、或旧安装无法判断的，更新前都要确认 */
export function needsReplaceConfirm(skill: LibrarySkill): boolean {
  return skill.edited !== "no";
}

export function skillStatusTags(skill: LibrarySkill, check?: SkillCheck): SkillStatusTag[] {
  const tags: SkillStatusTag[] = [];
  if (isGone(skill, check)) tags.push("gone");
  else if (check?.status === "update") tags.push("update");
  // folder / imported 来源检查时返回 unsupported，不算“没检查成”
  else if (check?.status === "unknown" && isTracked(skill)) tags.push("unchecked");
  if (skill.edited === "yes") tags.push("edited");
  if (skill.folderMissing) tags.push("folderMissing");
  return tags;
}

/** 来源行文字：仓库、地址或本机路径 */
export function skillSourceText(skill: LibrarySkill): string {
  const p = skill.provenance;
  if (p.kind === "github" && p.repo) return p.path ? `${p.repo}/${p.path}` : p.repo;
  if (p.kind === "git" && p.repo) return p.path ? `${gitLabel(p.repo)} · ${p.path}` : gitLabel(p.repo);
  if (p.kind === "folder") return p.linkedPath ?? skill.dirPath;
  if (p.kind === "imported") return p.importedFrom ?? skill.dirPath;
  return skill.dirPath;
}

export function filterLibrarySkills(skills: readonly LibrarySkill[], query: string): LibrarySkill[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...skills];
  return skills.filter((skill) =>
    `${skill.name} ${skill.id} ${skill.description ?? ""} ${skillSourceText(skill)}`.toLowerCase().includes(needle),
  );
}

export interface BulkUpdatePlan {
  /** 直接更新的 id */
  ids: string[];
  /** 本地改动过或无法判断、这次跳过的技能名，提示用户到各自的行里单独更新 */
  skippedNames: string[];
}

/** 「更新 N 个」：只更新检查出有更新、上游还在、没被改过的；改过的跳过并报名字。 */
export function planBulkUpdate(skills: readonly LibrarySkill[], checks: Readonly<Record<string, SkillCheck>>): BulkUpdatePlan {
  const ids: string[] = [];
  const skippedNames: string[] = [];
  for (const skill of skills) {
    const check = checks[skill.id];
    if (check?.status !== "update" || isGone(skill, check)) continue;
    if (needsReplaceConfirm(skill)) skippedNames.push(skill.name);
    else ids.push(skill.id);
  }
  return { ids, skippedNames };
}

export const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** 距上次检查超过 12 小时（或从没检查过、时间记录坏了）就该自动检查一次 */
export function autoCheckDue(lastCheckedAt: number | null, now: number): boolean {
  if (lastCheckedAt === null || !Number.isFinite(lastCheckedAt)) return true;
  return now - lastCheckedAt >= AUTO_CHECK_INTERVAL_MS || lastCheckedAt > now;
}

/** probe 结果默认勾选：新候选不超过 3 个时全选，多了让用户自己挑（同 magpie） */
export function defaultProbePicks(candidates: readonly { path: string; have: boolean }[]): Set<string> {
  const fresh = candidates.filter((candidate) => !candidate.have);
  return new Set(fresh.length <= 3 ? fresh.map((candidate) => candidate.path) : []);
}

/** 后端内置清单（manifest）的名字不带前缀，启动档策略里存的是 `ccpanes-<name>`。 */
export function bundledPolicyName(name: string): string {
  return name.startsWith("ccpanes-") ? name : `ccpanes-${name}`;
}

/**
 * 内置技能分组要列的名字：默认核心在前（保持原顺序），其余按后端清单补齐并按字母排。
 * custom 模式只挂载勾选的内置技能，没列出来的就没有地方能打开。
 */
export function builtinSkillRows(
  bundled: ReadonlyArray<{ name: string }>,
  core: ReadonlyArray<string> = BUILTIN_SKILLS,
): string[] {
  const seen = new Set(core);
  const rest = bundled
    .map((item) => bundledPolicyName(item.name))
    .filter((name) => !seen.has(name) && (seen.add(name), true))
    .sort((a, b) => a.localeCompare(b));
  return [...core, ...rest];
}
