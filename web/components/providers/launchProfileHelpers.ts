import type { TFunction } from "i18next";
import type {
  DiscoveredExternalSkill,
  InstalledUserSkill,
  LaunchProfile,
  LaunchProfileDraft,
  LaunchProfileRuntime,
  SkillMarketEntry,
} from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import type { Workspace } from "@/types/workspace";
import { CLI_TOOL_TABS } from "@/types/provider";

export type ProfilesT = TFunction<["providers", "common"]>;

export const SYSTEM_DEFAULT_PROFILE_ID = "__system_default__";
export const WORKSPACE_FILTER_ALL = "__all_workspaces__";
/**
 * Radix Select 不允许 item value 为空字符串，"不指定/继承默认" 类选项统一用该哨兵值，
 * 在 onValueChange 回调里转换回 null / ""。
 */
export const SELECT_NONE = "__none__";

export const BUILTIN_SKILLS = [
  "ccpanes-launch-task",
  "ccpanes-dispatch-task",
  "ccpanes-dispatch-todos",
  "ccpanes-browse-sessions",
  "ccpanes-memory-dual-write",
];

export type ExternalSkillSourceKind = "claude" | "codex" | "plugin";

export const EXTERNAL_SKILL_GROUPS: Array<{
  kind: ExternalSkillSourceKind;
  label: string;
  policyKey: "includeExternalClaudeSkills" | "includeExternalCodexSkills" | "includeExternalPluginSkills";
  applicableTools: KnownCliTool[];
}> = [
  { kind: "claude", label: "Claude", policyKey: "includeExternalClaudeSkills", applicableTools: ["claude"] },
  { kind: "codex", label: "Codex", policyKey: "includeExternalCodexSkills", applicableTools: ["codex"] },
  { kind: "plugin", label: "Plugin", policyKey: "includeExternalPluginSkills", applicableTools: ["claude"] },
];

export const TOOL_LABELS: Record<KnownCliTool, string> = {
  none: "",
  claude: "Claude",
  codex: "Codex",
  pi: "Pi",
  gemini: "Gemini",
  kimi: "Kimi",
  glm: "GLM",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};

export const inputClass = "h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-70";

export function toolLabel(tool: KnownCliTool | string, t: ProfilesT): string {
  if (tool === "none") return t("toolNone");
  return TOOL_LABELS[tool as KnownCliTool] || tool;
}

export function profileMatchesTool(
  profile: Pick<LaunchProfile, "targetTools">,
  tool: KnownCliTool,
): boolean {
  return profile.targetTools.length === 0 || profile.targetTools.includes(tool);
}

/** 每个 CLI tab 的运行配置数（统一 header 的 chips 计数用） */
export function countProfilesPerTool(profiles: LaunchProfile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tab of CLI_TOOL_TABS) {
    counts[tab.id] = profiles.filter((profile) => profileMatchesTool(profile, tab.id)).length;
  }
  return counts;
}

export function launchEnvironmentLabel(targetTools: string[], fallbackTool: KnownCliTool, t: ProfilesT): string {
  return toolLabel(targetTools[0] ?? fallbackTool, t);
}

export function runtimeLabel(runtime: LaunchProfileRuntime, t: ProfilesT): string {
  return runtime ? t(`runtime.${runtime}`) : t("runtimeAll");
}

export function isSharedMcpServerSelected(policy: LaunchProfileDraft["mcpPolicy"], name: string): boolean {
  if (!policy.includeSharedMcp || policy.mode === "disabled") return false;
  if (policy.mode === "custom") return policy.enabledServerIds.includes(name);
  return !policy.disabledServerIds.includes(name);
}

export function selectedSharedMcpCount(policy: LaunchProfileDraft["mcpPolicy"], names: string[]): number {
  return names.filter((name) => isSharedMcpServerSelected(policy, name)).length;
}

export function builtinSkillId(name: string): string {
  return `builtin:${name}`;
}

export function isBuiltinSkillSelected(policy: LaunchProfileDraft["skillPolicy"], name: string): boolean {
  const id = builtinSkillId(name);
  if (policy.mode === "disabled") return false;
  if (policy.mode === "custom") return policy.enabledSkillIds.includes(id);
  return !policy.disabledSkillIds.includes(id);
}

export function selectedBuiltinSkillCount(policy: LaunchProfileDraft["skillPolicy"]): number {
  return BUILTIN_SKILLS.filter((name) => isBuiltinSkillSelected(policy, name)).length;
}

export function profileSkillId(id: string): string {
  return `profile:${id}`;
}

export function isProfileSkillSelected(policy: LaunchProfileDraft["skillPolicy"], id: string): boolean {
  const skillId = profileSkillId(id);
  if (policy.mode === "disabled") return false;
  if (policy.mode === "custom") return policy.enabledSkillIds.includes(skillId);
  return !policy.disabledSkillIds.includes(skillId);
}

export function selectedProfileSkillCount(policy: LaunchProfileDraft["skillPolicy"]): number {
  return policy.profileSkills.filter((skill) => isProfileSkillSelected(policy, skill.id)).length;
}

export function userSkillId(id: string): string {
  return `user:${id}`;
}

export function isUserSkillSelected(policy: LaunchProfileDraft["skillPolicy"], id: string): boolean {
  if (policy.mode === "disabled") return false;
  return policy.enabledSkillIds.includes(userSkillId(id));
}

export function selectedUserSkillCount(policy: LaunchProfileDraft["skillPolicy"], skills: InstalledUserSkill[]): number {
  return skills.filter((skill) => isUserSkillSelected(policy, skill.id)).length;
}

export function externalSkillSourceKind(skill: DiscoveredExternalSkill): ExternalSkillSourceKind {
  return skill.source.kind;
}

export function isExternalSourceIncluded(
  policy: LaunchProfileDraft["skillPolicy"],
  kind: ExternalSkillSourceKind,
): boolean {
  const group = EXTERNAL_SKILL_GROUPS.find((item) => item.kind === kind);
  return group ? policy[group.policyKey] ?? true : true;
}

export function isExternalSkillSelected(policy: LaunchProfileDraft["skillPolicy"], skill: DiscoveredExternalSkill): boolean {
  if (policy.mode === "disabled" || !isExternalSourceIncluded(policy, externalSkillSourceKind(skill))) return false;
  if (policy.mode === "custom") return policy.enabledSkillIds.includes(skill.id);
  return !policy.disabledSkillIds.includes(skill.id);
}

export function selectedExternalSkillCount(policy: LaunchProfileDraft["skillPolicy"], skills: DiscoveredExternalSkill[]): number {
  return skills.filter((skill) => isExternalSkillSelected(policy, skill)).length;
}

export function installableMarketEntry(entry: SkillMarketEntry): boolean {
  return Boolean(entry.license?.trim() && entry.contentUrl?.trim() && entry.sha256?.trim());
}

export function profileDisplayName(profile: Pick<LaunchProfile, "name" | "alias">): string {
  return profile.alias?.trim() || profile.name;
}

export function draftDisplayName(draft: Pick<LaunchProfileDraft, "name" | "alias">, t: ProfilesT): string {
  return draft.alias?.trim() || draft.name?.trim() || t("profileFallbackName");
}

export function workspaceProfileIds(workspace: Workspace | null): Set<string> {
  const ids = new Set<string>();
  if (!workspace) return ids;
  if (workspace.launchProfileId) ids.add(workspace.launchProfileId);
  for (const project of workspace.projects) {
    if (project.launchProfileId) ids.add(project.launchProfileId);
  }
  return ids;
}

export function systemDefaultLaunchProfileDraft(
  tool: KnownCliTool,
  runtime: LaunchProfileRuntime = null,
  t: ProfilesT,
): LaunchProfileDraft {
  return {
    name: t("systemDefaultName", { tool: toolLabel(tool, t) }),
    alias: t("systemDefaultName", { tool: toolLabel(tool, t) }),
    description: t("systemDefaultDescription"),
    providerId: null,
    modelId: null,
    adapterOptions: {},
    targetTools: [tool],
    targetRuntime: runtime,
    yoloMode: false,
    mcpPolicy: {
      mode: "default",
      enabledServerIds: [],
      disabledServerIds: [],
      includeCcpanesMcp: true,
      includeSharedMcp: true,
    },
    skillPolicy: {
      mode: "core",
      enabledSkillIds: [],
      disabledSkillIds: [],
      profileSkills: [],
      includeProjectSkills: true,
      includeExternalClaudeSkills: true,
      includeExternalCodexSkills: true,
      includeExternalPluginSkills: true,
      target: "session",
    },
    isDefault: false,
  };
}

export function toDraft(profile: LaunchProfile): LaunchProfileDraft {
  return {
    name: profile.name,
    alias: profile.alias ?? profile.name,
    description: profile.description ?? "",
    providerId: profile.providerId ?? null,
    modelId: profile.modelId ?? null,
    adapterOptions: { ...(profile.adapterOptions ?? {}) },
    targetTools: profile.targetTools,
    targetRuntime: profile.targetRuntime ?? null,
    yoloMode: profile.yoloMode ?? false,
    mcpPolicy: profile.mcpPolicy,
    skillPolicy: profile.skillPolicy,
    isDefault: profile.isDefault,
  };
}
