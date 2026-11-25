// 运行配置 MCP / Skill 卡「新增」的纯函数层：从已有资源里挑一个开给当前草稿。
// 切换规则复用资源库的 setMcpResource / setSkillResource，保证两处入口口径一致。
import { setMcpResource, setSkillResource, type ProfileSkillResource } from "@/components/resources/resourceCenterModel";
import type { LaunchProfileDraft } from "@/types";

/**
 * 给草稿开 / 关一个共享 MCP。
 *
 * 草稿没勾「共享 MCP 服务」时，单独选一个也得先把总开关打开；默认组合模式下总开关一开就是
 * 全部共享 server，所以同时把其余 server 记进 disabledServerIds——用户点的是「加这一个」，
 * 不能顺带把整个共享池都放进来。自定义模式本来就只认 enabledServerIds，无需额外处理。
 */
export function nextSetSharedMcp(
  current: LaunchProfileDraft,
  name: string,
  on: boolean,
  allSharedNames: readonly string[],
): LaunchProfileDraft {
  if (current.mcpPolicy.mode === "disabled") return current;
  let base = current;
  if (on && !current.mcpPolicy.includeSharedMcp) {
    const disabled = new Set(current.mcpPolicy.disabledServerIds);
    if (current.mcpPolicy.mode === "default") {
      for (const other of allSharedNames) if (other !== name) disabled.add(other);
    }
    base = {
      ...current,
      mcpPolicy: { ...current.mcpPolicy, includeSharedMcp: true, disabledServerIds: Array.from(disabled) },
    };
  }
  return setMcpResource(base, { kind: "shared", name }, on);
}

/** 给草稿开 / 关一个资源库技能或内置技能；Skill 整体停用时不动。 */
export function nextSetSkill(
  current: LaunchProfileDraft,
  resource: Extract<ProfileSkillResource, { kind: "user" | "builtin" }>,
  on: boolean,
): LaunchProfileDraft {
  return setSkillResource(current, resource, on);
}

/**
 * 草稿里已选、但后端预览（按已保存配置算的）还没有的条目——即「新增了、保存后才生效」。
 * 预览未就绪时返回空，避免把整份选择都当成新增。
 */
export function pendingAdditions(
  selectedNames: readonly string[],
  effective: readonly { name: string }[] | null | undefined,
): string[] {
  if (!effective) return [];
  const known = new Set(effective.map((item) => item.name));
  return selectedNames.filter((name) => !known.has(name));
}
