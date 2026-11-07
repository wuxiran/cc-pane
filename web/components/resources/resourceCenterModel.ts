// 资源中心的纯函数层：把“资源 × 启动档”算成开关状态，并给出切换后的策略。
// 开关只读写启动档现有策略字段（docs/109 §3.2），判定和切换都复用启动档编辑页的函数。
import {
  EXTERNAL_SKILL_GROUPS,
  isBuiltinSkillSelected,
  isSharedMcpServerSelected,
  isUserSkillSelected,
  userSkillId,
} from "@/components/providers/launchProfileHelpers";
import { nextToggleBuiltinSkill, nextToggleServer } from "@/components/providers/launchProfileSkillPolicy";
import type { LaunchProfile, LaunchProfileDraft } from "@/types";
import type { SharedMcpRemote, SharedMcpServerStatus } from "@/types/shared-mcp";
import { isSharedMcpFailed } from "@/types/shared-mcp";

/** 受启动档控制的 MCP：内置 ccpanes、共享 server，或工作空间 / 项目层的 server */
export type ProfileMcpResource =
  | { kind: "ccpanes" }
  | { kind: "shared"; name: string }
  | { kind: "layer"; name: string };

/** 不能切换的原因，对应 i18n `resourceCenter.blocked.*` */
export type ChipBlockReason = "mcpDisabled" | "sharedOff" | "remoteUnsupported" | "skillsDisabled";

export interface ProfileChipState {
  on: boolean;
  blocked: ChipBlockReason | null;
}

type McpPolicy = LaunchProfile["mcpPolicy"];

export function mcpChipState(policy: McpPolicy, resource: ProfileMcpResource): ProfileChipState {
  if (policy.mode === "disabled") return { on: false, blocked: "mcpDisabled" };
  if (resource.kind === "ccpanes") return { on: policy.includeCcpanesMcp, blocked: null };
  // 层配置和共享开关无关，规则见 terminal_service.rs 的 allowed_mcp_server_ids_for_profile
  if (resource.kind === "layer") {
    const on = policy.mode === "custom"
      ? policy.enabledServerIds.includes(resource.name)
      : !policy.disabledServerIds.includes(resource.name);
    return { on, blocked: null };
  }
  if (!policy.includeSharedMcp) return { on: false, blocked: "sharedOff" };
  return { on: isSharedMcpServerSelected(policy, resource.name), blocked: null };
}

/**
 * 这个启动档连不上这条远程 MCP。规则与 terminal_service.rs 的 remote_mcp_supported 一致：
 * 只有本机的 Claude、Codex 能带请求头，Codex 不支持 SSE，jcode 只认 stdio。
 * 没指定 CLI 的启动档可能用到任一家，不算不支持。
 */
export function remoteUnsupportedByProfile(profile: Pick<LaunchProfile, "targetTools" | "targetRuntime">, remote: SharedMcpRemote): boolean {
  if (profile.targetTools.length === 0) return false;
  const sse = remote.transport === "sse";
  const headers = Object.keys(remote.headers).length > 0;
  const local = !profile.targetRuntime || profile.targetRuntime === "local";
  return profile.targetTools.every((tool) => {
    if (tool === "jcode") return true;
    if (!local) return headers || sse;
    if (tool === "claude") return false;
    if (tool === "codex") return sse;
    return headers || sse;
  });
}

export function toggleMcpResource(draft: LaunchProfileDraft, resource: ProfileMcpResource): LaunchProfileDraft {
  if (resource.kind === "ccpanes") {
    return { ...draft, mcpPolicy: { ...draft.mcpPolicy, includeCcpanesMcp: !draft.mcpPolicy.includeCcpanesMcp } };
  }
  return nextToggleServer(draft, resource.name);
}

/** 把策略切到想要的状态；已经是该状态时原样返回，连点和“全部”都不会反复翻转。 */
export function setMcpResource(
  draft: LaunchProfileDraft,
  resource: ProfileMcpResource,
  on: boolean,
): LaunchProfileDraft {
  const state = mcpChipState(draft.mcpPolicy as McpPolicy, resource);
  if (state.blocked || state.on === on) return draft;
  return toggleMcpResource(draft, resource);
}

/** “全部”：可切换的启动档都开着才算开；一个都不能切换时不提供。 */
export function allChipState(states: readonly ProfileChipState[]): { available: boolean; on: boolean } {
  const usable = states.filter((state) => !state.blocked);
  return { available: usable.length >= 2, on: usable.length > 0 && usable.every((state) => state.on) };
}

type SkillPolicy = LaunchProfile["skillPolicy"];

/** 技能的组开关：工作空间技能、各 CLI 自带技能（条目只读，只能整组开关） */
export type SkillGroupKey =
  | "includeWorkspaceSkills"
  | (typeof EXTERNAL_SKILL_GROUPS)[number]["policyKey"];

/** 受启动档控制的技能：资源库技能（user:<id>）、内置技能（builtin:<name>）或一整组 */
export type ProfileSkillResource =
  | { kind: "user"; id: string }
  | { kind: "builtin"; name: string }
  | { kind: "group"; key: SkillGroupKey };

export function skillChipState(policy: SkillPolicy, resource: ProfileSkillResource): ProfileChipState {
  if (policy.mode === "disabled") return { on: false, blocked: "skillsDisabled" };
  if (resource.kind === "user") return { on: isUserSkillSelected(policy, resource.id), blocked: null };
  if (resource.kind === "builtin") return { on: isBuiltinSkillSelected(policy, resource.name), blocked: null };
  return { on: policy[resource.key] !== false, blocked: null };
}

/**
 * 把技能策略切到想要的状态。用户技能只增删 `user:<id>`，**不改 mode**（和启动档编辑页不同，
 * 那里切换会强制 custom）；内置技能 core 模式翻 disabledSkillIds、custom 模式翻 enabledSkillIds。
 */
export function setSkillResource(
  draft: LaunchProfileDraft,
  resource: ProfileSkillResource,
  on: boolean,
): LaunchProfileDraft {
  const policy = draft.skillPolicy as SkillPolicy;
  const state = skillChipState(policy, resource);
  if (state.blocked || state.on === on) return draft;
  if (resource.kind === "builtin") return nextToggleBuiltinSkill(draft, resource.name);
  if (resource.kind === "group") return { ...draft, skillPolicy: { ...draft.skillPolicy, [resource.key]: on } };
  const id = userSkillId(resource.id);
  const enabled = draft.skillPolicy.enabledSkillIds.filter((item) => item !== id);
  return {
    ...draft,
    skillPolicy: {
      ...draft.skillPolicy,
      enabledSkillIds: on ? [...enabled, id] : enabled,
      disabledSkillIds: draft.skillPolicy.disabledSkillIds.filter((item) => item !== id),
    },
  };
}

export type McpStatusLevel = "running" | "starting" | "stopped" | "failed";

/** 共享 server 的显示状态。失败原因要写在行内，不放进 tooltip。 */
export function mcpStatusOf(status: SharedMcpServerStatus): { level: McpStatusLevel; reason: string | null } {
  if (isSharedMcpFailed(status)) return { level: "failed", reason: status.failed.message };
  return { level: status, reason: null };
}

const DEFAULT_VISIBLE_PROFILES = 6;

/** 默认档排最前；用户选过就按用户选的，已删除的启动档自动忽略。 */
export function visibleProfiles(
  profiles: readonly LaunchProfile[],
  chosenIds: readonly string[] | null,
  limit = DEFAULT_VISIBLE_PROFILES,
): LaunchProfile[] {
  const ordered = [...profiles].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  if (chosenIds) {
    const chosen = ordered.filter((profile) => chosenIds.includes(profile.id));
    if (chosen.length > 0) return chosen;
  }
  return ordered.slice(0, limit);
}

/** 粘贴行能否添加。工作空间 / 项目层存不了远程条目，共享层可以；重名默认不选，由用户决定。 */
export function pasteRowProblem(
  server: { name: string; url?: string },
  existingNames: ReadonlySet<string>,
  allowRemote = false,
): "remote" | "noName" | "exists" | null {
  if (server.url && !allowRemote) return "remote";
  if (!server.name) return "noName";
  return existingNames.has(server.name) ? "exists" : null;
}

/** 按后端配置的端口范围依次分配未占用端口，一次粘贴多条也不会撞。不够时抛错，不越界。 */
export function nextSharedPorts(
  used: readonly number[],
  count: number,
  range: { start: number; end: number },
): number[] {
  const taken = new Set(used);
  const ports: number[] = [];
  for (let port = range.start; port <= range.end && ports.length < count; port += 1) {
    if (!taken.has(port)) ports.push(port);
  }
  if (ports.length < count) throw new Error(`No free port in ${range.start}-${range.end}`);
  return ports;
}
