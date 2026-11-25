// 会话启动时把「实际用的运行配置」拍成快照（纯函数，不碰 store）。
//
// 终端口径镜像后端 launch_profile_service::resolve_launch_profile_with_diagnostic：
// 点名的 id（或工作空间绑定的配置）存在且适用于该 CLI → 用它；否则回落到适用于该 CLI 的
// isDefault 配置；都没有 = 系统默认。Agent Chat 不回落（空 id 即系统默认）。
import type { LaunchProfile, LaunchProviderSelection } from "@/types/launch-profile";
import type { LaunchProfileSnapshot } from "@/types/launch-profile-snapshot";
import type { Provider } from "@/types/provider";
import {
  launchProfileDisplayName,
  profileMatchesCli,
  resolveCredential,
  resolveModel,
} from "./launchProfileDisplay";

export interface LaunchProfileCaptureInput {
  /** 本次启动请求里点名的配置 id。 */
  launchProfileId?: string | null;
  /** 工作空间绑定的配置 id（终端：点名缺失时后端用它）。 */
  workspaceLaunchProfileId?: string | null;
  cliTool?: string | null;
  providerId?: string | null;
  providerAccountId?: string | null;
  providerSelection?: LaunchProviderSelection | null;
  modelId?: string | null;
}

export interface LaunchProfileCaptureContext {
  profiles: readonly LaunchProfile[];
  providers: readonly Provider[];
  mode: "terminal" | "chat";
  now?: () => Date;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizedCli(cliTool: string | null | undefined): string | null {
  const tool = clean(cliTool)?.toLowerCase() ?? null;
  return tool && tool !== "none" ? tool : null;
}

/** 启动时实际会用的配置（镜像后端）；null = 系统默认。 */
export function resolveLaunchedProfile(
  input: LaunchProfileCaptureInput,
  ctx: Pick<LaunchProfileCaptureContext, "profiles" | "mode">,
): { profile: LaunchProfile | null; implicitDefault: boolean } {
  const candidate = clean(input.launchProfileId)
    ?? (ctx.mode === "terminal" ? clean(input.workspaceLaunchProfileId) : null);
  if (ctx.mode === "chat") {
    const profile = candidate ? ctx.profiles.find((item) => item.id === candidate) ?? null : null;
    return { profile, implicitDefault: false };
  }
  const cliTool = normalizedCli(input.cliTool);
  const named = candidate
    ? ctx.profiles.find((item) => item.id === candidate && profileMatchesCli(item, cliTool))
    : undefined;
  if (named) return { profile: named, implicitDefault: false };
  const fallback = ctx.profiles.find((item) => item.isDefault && profileMatchesCli(item, cliTool));
  return { profile: fallback ?? null, implicitDefault: Boolean(fallback) };
}

export function buildLaunchProfileSnapshot(
  input: LaunchProfileCaptureInput,
  ctx: LaunchProfileCaptureContext,
): LaunchProfileSnapshot {
  const { profile, implicitDefault } = resolveLaunchedProfile(input, ctx);
  const credential = resolveCredential(input, profile, ctx.providers);
  return {
    launchProfileId: profile?.id ?? null,
    ...(profile ? { name: launchProfileDisplayName(profile) } : {}),
    ...(implicitDefault ? { implicitDefault: true } : {}),
    ...(credential ? { credential } : {}),
    model: resolveModel(input, profile, ctx.providers),
    capturedAt: (ctx.now?.() ?? new Date()).toISOString(),
  };
}

/**
 * 重新启动（恢复 / 重连 / 分屏复制）时传给后端的配置 id：点名的优先，其次沿用快照里
 * 启动时实际解析出的那个——否则默认配置换过后，恢复出来的会话会悄悄换成新默认，
 * 与快照显示的不一致。
 */
export function launchProfileIdForLaunch(source: {
  launchProfileId?: string | null;
  launchProfileSnapshot?: LaunchProfileSnapshot | null;
}): string | undefined {
  return clean(source.launchProfileId) ?? clean(source.launchProfileSnapshot?.launchProfileId) ?? undefined;
}
