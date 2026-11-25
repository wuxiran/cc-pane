// 会话里只读展示「当前用的运行配置」：把会话记下的 launchProfileId + 启动时的供应商/模型
// 解析成一份展示模型（名称、凭证类型、模型）。纯函数，不碰 store，组件负责喂数据。
//
// 口径（镜像后端 launch_profile_service::resolve_launch_profile）：
// - 终端：id 为空 → 后端回落到匹配该 CLI 的 isDefault 配置；没有就是系统默认。
// - Agent Chat：id 为空 = 系统默认（后端不回落）。
// 配置被删 → 「已删除的配置」；还没加载过 → unknown（不误报删除）。
//
// 有启动快照（launchProfileSnapshot）时快照优先：配置还在 → 名字用当前的（改名后显示新名），
// 凭证/模型用快照（反映实际启动值）；配置已删 → 显示快照里的原名并标注已删除。
import type { LaunchProfile, LaunchProviderSelection } from "@/types/launch-profile";
import type { LaunchCredentialDisplay, LaunchProfileSnapshot } from "@/types/launch-profile-snapshot";
import {
  isDefaultLoginAccount,
  isSystemProvider,
  providerDefaultAccount,
  type Provider,
} from "@/types/provider";

export interface LaunchProfileSessionInput {
  launchProfileId?: string | null;
  cliTool?: string | null;
  providerId?: string | null;
  providerAccountId?: string | null;
  providerSelection?: LaunchProviderSelection | null;
  modelId?: string | null;
  /** 启动时记下的运行配置快照；旧数据没有（走按当前配置推断的旧口径）。 */
  launchProfileSnapshot?: LaunchProfileSnapshot | null;
}

export type { LaunchCredentialDisplay };

export type LaunchProfileDisplayKind = "profile" | "implicitDefault" | "systemDefault" | "deleted" | "unknown";

export interface LaunchProfileDisplay {
  kind: LaunchProfileDisplayKind;
  /** profile / implicitDefault：配置的当前名称；deleted：快照里的原名（旧数据没有）。 */
  name?: string;
  credential: LaunchCredentialDisplay | null;
  model: string | null;
}

export interface LaunchProfileDisplayContext {
  profiles: readonly LaunchProfile[];
  profilesLoaded: boolean;
  providers: readonly Provider[];
  /** terminal：空 id 回落 isDefault 配置；chat：空 id 即系统默认。 */
  mode: "terminal" | "chat";
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function launchProfileDisplayName(profile: Pick<LaunchProfile, "name" | "alias">): string {
  return clean(profile.alias) ?? profile.name;
}

export function profileMatchesCli(profile: LaunchProfile, cliTool: string | null): boolean {
  return !cliTool || profile.targetTools.length === 0 || profile.targetTools.includes(cliTool);
}

function resolveProfile(
  input: LaunchProfileSessionInput,
  ctx: LaunchProfileDisplayContext,
): { kind: LaunchProfileDisplayKind; profile: LaunchProfile | null } {
  const id = clean(input.launchProfileId);
  if (id) {
    const profile = ctx.profiles.find((item) => item.id === id) ?? null;
    if (profile) return { kind: "profile", profile };
    return { kind: ctx.profilesLoaded ? "deleted" : "unknown", profile: null };
  }
  if (ctx.mode === "terminal") {
    const cliTool = clean(input.cliTool);
    const fallback = ctx.profiles.find((item) => item.isDefault && profileMatchesCli(item, cliTool));
    if (fallback) return { kind: "implicitDefault", profile: fallback };
  }
  return { kind: "systemDefault", profile: null };
}

export function resolveCredential(
  input: LaunchProfileSessionInput,
  profile: LaunchProfile | null,
  providers: readonly Provider[],
): LaunchCredentialDisplay | null {
  if (input.providerSelection === "none") return { kind: "cli" };
  const providerId = clean(input.providerId) ?? clean(profile?.providerId);
  if (!providerId || isSystemProvider(providerId)) return { kind: "cli" };
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) return providers.length > 0 ? { kind: "missingRelay" } : null;
  const accountId = clean(input.providerAccountId) ?? clean(profile?.providerAccountId);
  if (isDefaultLoginAccount(accountId)) return { kind: "cli" };
  const account = (accountId ? provider.accounts?.find((item) => item.id === accountId) : undefined)
    ?? providerDefaultAccount(provider);
  if (account?.kind === "login") return { kind: "login", name: account.name || provider.name };
  const accountName = (provider.accounts?.length ?? 0) > 1 ? account?.name : undefined;
  return { kind: "relay", name: provider.name, ...(accountName ? { accountName } : {}) };
}

export function resolveModel(
  input: LaunchProfileSessionInput,
  profile: LaunchProfile | null,
  providers: readonly Provider[],
): string | null {
  const direct = clean(input.modelId) ?? clean(profile?.modelId);
  if (direct) return direct;
  const providerId = clean(input.providerId) ?? clean(profile?.providerId);
  const provider = providerId ? providers.find((item) => item.id === providerId) : undefined;
  return clean(provider?.defaultModelId);
}

function describeFromSnapshot(
  snapshot: LaunchProfileSnapshot,
  input: LaunchProfileSessionInput,
  ctx: LaunchProfileDisplayContext,
): LaunchProfileDisplay {
  const id = clean(snapshot.launchProfileId);
  const profile = id ? ctx.profiles.find((item) => item.id === id) ?? null : null;
  const credential = snapshot.credential ?? resolveCredential(input, profile, ctx.providers);
  const model = snapshot.model ?? null;
  if (!id) return { kind: "systemDefault", credential, model };
  const liveKind: LaunchProfileDisplayKind = snapshot.implicitDefault ? "implicitDefault" : "profile";
  if (profile) return { kind: liveKind, name: launchProfileDisplayName(profile), credential, model };
  const name = clean(snapshot.name) ?? undefined;
  // 还没加载过：先信快照里的名字，不误报删除。
  const kind: LaunchProfileDisplayKind = ctx.profilesLoaded ? "deleted" : liveKind;
  return { kind, ...(name ? { name } : {}), credential, model };
}

export function describeLaunchProfile(
  input: LaunchProfileSessionInput,
  ctx: LaunchProfileDisplayContext,
): LaunchProfileDisplay {
  if (input.launchProfileSnapshot) return describeFromSnapshot(input.launchProfileSnapshot, input, ctx);
  const { kind, profile } = resolveProfile(input, ctx);
  return {
    kind,
    ...(profile ? { name: launchProfileDisplayName(profile) } : {}),
    credential: resolveCredential(input, profile, ctx.providers),
    model: resolveModel(input, profile, ctx.providers),
  };
}
