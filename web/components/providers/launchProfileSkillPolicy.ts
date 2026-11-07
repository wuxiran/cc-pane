import type { DiscoveredExternalSkill, LaunchProfileDraft } from "@/types";
import type { SharedMcpServerInfo } from "@/types/shared-mcp";
import {
  BUILTIN_SKILLS,
  EXTERNAL_SKILL_GROUPS,
  builtinSkillId,
  externalSkillSourceKind,
  isExternalSourceIncluded,
  profileSkillId,
  type ExternalSkillSourceKind,
} from "./launchProfileHelpers";

/**
 * 运行配置草稿的 MCP / Skill 策略变换，全部是纯函数 `(draft, ...deps) => draft`。
 *
 * 调用点统一写成 `setDraft((cur) => nextXxx(cur, arg))`——**不要**改回
 * `setDraft(nextXxx(draft, arg))` 这种捕获写法，连续两次 toggle 会读到 stale draft。
 * 原先闭包读取的 `servers` / `externalSkills` 在这里提升为显式入参。
 */

export function nextMcpMode(
  current: LaunchProfileDraft,
  mode: LaunchProfileDraft["mcpPolicy"]["mode"],
  servers: SharedMcpServerInfo[],
): LaunchProfileDraft {
  const enabledServerIds = new Set(current.mcpPolicy.enabledServerIds);
  if (mode === "custom" && current.mcpPolicy.mode !== "custom" && enabledServerIds.size === 0) {
    const disabledServerIds = new Set(current.mcpPolicy.disabledServerIds);
    for (const server of servers) {
      if (!disabledServerIds.has(server.name)) enabledServerIds.add(server.name);
    }
  }

  return {
    ...current,
    mcpPolicy: {
      ...current.mcpPolicy,
      mode,
      includeCcpanesMcp: mode === "disabled" ? false : current.mcpPolicy.includeCcpanesMcp || current.mcpPolicy.mode === "disabled",
      includeSharedMcp: mode === "disabled" ? false : current.mcpPolicy.includeSharedMcp || current.mcpPolicy.mode === "disabled",
      enabledServerIds: Array.from(enabledServerIds),
    },
  };
}

export function nextSkillMode(
  current: LaunchProfileDraft,
  mode: LaunchProfileDraft["skillPolicy"]["mode"],
  externalSkills: DiscoveredExternalSkill[],
): LaunchProfileDraft {
  const enabled = new Set(current.skillPolicy.enabledSkillIds);
  if (mode === "custom" && current.skillPolicy.mode !== "custom") {
    const disabled = new Set(current.skillPolicy.disabledSkillIds);
    const hasBuiltinSelection = BUILTIN_SKILLS.some((name) => enabled.has(builtinSkillId(name)));
    if (!hasBuiltinSelection) {
      for (const name of BUILTIN_SKILLS) {
        if (!disabled.has(builtinSkillId(name))) enabled.add(builtinSkillId(name));
      }
    }
    for (const skill of current.skillPolicy.profileSkills) {
      const id = profileSkillId(skill.id);
      if (!disabled.has(id)) enabled.add(id);
    }
    for (const skill of externalSkills) {
      if (
        isExternalSourceIncluded(current.skillPolicy, externalSkillSourceKind(skill))
        && !disabled.has(skill.id)
      ) {
        enabled.add(skill.id);
      }
    }
  }

  return {
    ...current,
    skillPolicy: {
      ...current.skillPolicy,
      mode,
      enabledSkillIds: Array.from(enabled),
    },
  };
}

export function nextToggleServer(current: LaunchProfileDraft, name: string): LaunchProfileDraft {
  const enabled = new Set(current.mcpPolicy.enabledServerIds);
  const disabled = new Set(current.mcpPolicy.disabledServerIds);
  if (current.mcpPolicy.mode === "default") {
    if (disabled.has(name)) disabled.delete(name);
    else disabled.add(name);
    return {
      ...current,
      mcpPolicy: {
        ...current.mcpPolicy,
        disabledServerIds: Array.from(disabled),
      },
    };
  }

  if (enabled.has(name)) enabled.delete(name);
  else enabled.add(name);
  return {
    ...current,
    mcpPolicy: {
      ...current.mcpPolicy,
      mode: "custom",
      enabledServerIds: Array.from(enabled),
    },
  };
}

export function nextToggleBuiltinSkill(current: LaunchProfileDraft, name: string): LaunchProfileDraft {
  const id = builtinSkillId(name);
  const enabled = new Set(current.skillPolicy.enabledSkillIds);
  const disabled = new Set(current.skillPolicy.disabledSkillIds);
  if (current.skillPolicy.mode === "core") {
    if (disabled.has(id)) disabled.delete(id);
    else disabled.add(id);
    return {
      ...current,
      skillPolicy: {
        ...current.skillPolicy,
        disabledSkillIds: Array.from(disabled),
      },
    };
  }

  if (enabled.has(id)) enabled.delete(id);
  else enabled.add(id);
  return {
    ...current,
    skillPolicy: {
      ...current.skillPolicy,
      mode: "custom",
      enabledSkillIds: Array.from(enabled),
      disabledSkillIds: Array.from(disabled).filter((item) => item !== id),
    },
  };
}

export function nextToggleProfileSkill(current: LaunchProfileDraft, id: string): LaunchProfileDraft {
  const skillId = profileSkillId(id);
  const enabled = new Set(current.skillPolicy.enabledSkillIds);
  const disabled = new Set(current.skillPolicy.disabledSkillIds);
  if (current.skillPolicy.mode === "core") {
    if (disabled.has(skillId)) disabled.delete(skillId);
    else disabled.add(skillId);
    return {
      ...current,
      skillPolicy: {
        ...current.skillPolicy,
        disabledSkillIds: Array.from(disabled),
      },
    };
  }

  if (enabled.has(skillId)) enabled.delete(skillId);
  else enabled.add(skillId);
  return {
    ...current,
    skillPolicy: {
      ...current.skillPolicy,
      mode: "custom",
      enabledSkillIds: Array.from(enabled),
      disabledSkillIds: Array.from(disabled).filter((item) => item !== skillId),
    },
  };
}

export function nextToggleExternalSource(
  current: LaunchProfileDraft,
  kind: ExternalSkillSourceKind,
  included: boolean,
): LaunchProfileDraft {
  const group = EXTERNAL_SKILL_GROUPS.find((item) => item.kind === kind);
  if (!group) return current;
  return {
    ...current,
    skillPolicy: {
      ...current.skillPolicy,
      [group.policyKey]: included,
    },
  };
}

export function nextUpsertProfileSkill(
  current: LaunchProfileDraft,
  skill: { id: string; name: string; description: string | null; content: string },
): LaunchProfileDraft {
  const skillId = profileSkillId(skill.id);
  const existingIndex = current.skillPolicy.profileSkills.findIndex((item) => item.id === skill.id);
  const profileSkills = [...current.skillPolicy.profileSkills];
  if (existingIndex >= 0) profileSkills[existingIndex] = skill;
  else profileSkills.push(skill);

  const enabled = new Set(current.skillPolicy.enabledSkillIds);
  const disabled = new Set(current.skillPolicy.disabledSkillIds);
  if (current.skillPolicy.mode === "custom") enabled.add(skillId);
  else disabled.delete(skillId);

  return {
    ...current,
    skillPolicy: {
      ...current.skillPolicy,
      profileSkills,
      enabledSkillIds: Array.from(enabled),
      disabledSkillIds: Array.from(disabled),
    },
  };
}

export function nextDeleteProfileSkill(current: LaunchProfileDraft, id: string): LaunchProfileDraft {
  const skillId = profileSkillId(id);
  return {
    ...current,
    skillPolicy: {
      ...current.skillPolicy,
      profileSkills: current.skillPolicy.profileSkills.filter((skill) => skill.id !== id),
      enabledSkillIds: current.skillPolicy.enabledSkillIds.filter((item) => item !== skillId),
      disabledSkillIds: current.skillPolicy.disabledSkillIds.filter((item) => item !== skillId),
    },
  };
}
