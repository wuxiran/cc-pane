// 导入中转站时顺带建运行配置：一条中转站 = 它所属智能体下的一条运行配置（凭证指向它，MCP / Skill 用默认组合）。
// 纯逻辑，供导入弹窗使用。
import type { ImportedProfileHints, LaunchProfile, LaunchProfileDraft, Provider, ProviderType } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { systemDefaultLaunchProfileDraft, toDraft, type ProfilesT } from "./launchProfileHelpers";

/** 供应商类型的原生 CLI（镜像后端 `native_cli_for_provider_type`）。 */
const NATIVE_CLI: Partial<Record<ProviderType, KnownCliTool>> = {
  anthropic: "claude",
  bedrock: "claude",
  vertex: "claude",
  proxy: "claude",
  config_profile: "claude",
  open_ai: "codex",
  gemini: "gemini",
  kimi: "kimi",
  opencode: "opencode",
  cursor: "cursor",
  grok: "grok",
};

export function nativeCliForProviderType(type: ProviderType): KnownCliTool | null {
  return NATIVE_CLI[type] ?? null;
}

/** 这个供应商在它的原生 CLI 下是否已有运行配置。 */
export function hasProfileForProvider(profiles: readonly LaunchProfile[], provider: Provider): boolean {
  const tool = nativeCliForProviderType(provider.providerType);
  return profiles.some((profile) => profile.providerId === provider.id
    && (!tool || (profile.targetTools ?? []).length === 0 || (profile.targetTools ?? []).includes(tool)));
}

export function importedProfileDraft(
  provider: Provider,
  description: string,
  t: ProfilesT,
  hints?: ImportedProfileHints | null,
): LaunchProfileDraft | null {
  const tool = nativeCliForProviderType(provider.providerType);
  if (!tool) return null;
  // 来源配置里拆出来的运行配置层：片段 / YOLO / 模型（模型必须是这个中转站里有的）
  const fragment = hints?.nativeTool === tool ? hints.nativeOverride?.trim() : undefined;
  const modelId = hints?.modelId && (provider.models ?? []).some((model) => model.id === hints.modelId)
    ? hints.modelId
    : null;
  return {
    ...systemDefaultLaunchProfileDraft(tool, t),
    name: provider.name,
    alias: provider.name,
    description,
    providerId: provider.id,
    providerAccountId: null,
    modelId,
    targetTools: [tool],
    yoloMode: hints?.yoloMode === true,
    ...(fragment ? { nativeOverrides: { [tool]: hints!.nativeOverride! } } : {}),
    isDefault: false,
  };
}

/** 这个供应商名下、片段还空着的运行配置（「补充原生配置」只填这些，绝不覆盖已有片段）。 */
export function profilesMissingFragment(
  profiles: readonly LaunchProfile[],
  provider: Provider,
  hints?: ImportedProfileHints | null,
): LaunchProfile[] {
  const tool = nativeCliForProviderType(provider.providerType);
  if (!tool || hints?.nativeTool !== tool || !hints.nativeOverride?.trim()) return [];
  return profiles.filter((profile) => profile.providerId === provider.id
    && ((profile.targetTools ?? []).length === 0 || (profile.targetTools ?? []).includes(tool))
    && !(profile.nativeOverrides?.[tool] ?? "").trim());
}

/** 给已有运行配置补上片段：其余字段原样保留。 */
export function supplementedProfileDraft(profile: LaunchProfile, hints: ImportedProfileHints): LaunchProfileDraft | null {
  const tool = hints.nativeTool;
  const fragment = hints.nativeOverride;
  if (!tool || !fragment?.trim() || (profile.nativeOverrides?.[tool] ?? "").trim()) return null;
  const draft = toDraft(profile);
  return { ...draft, nativeOverrides: { ...(draft.nativeOverrides ?? {}), [tool]: fragment } };
}
