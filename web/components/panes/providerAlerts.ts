// 状态栏的供应商提醒：只读本地数据（会话日志里的用量、已存的纯度检测报告），不发请求。
// 只对 API key 账号生效：订阅登录账号走官方通道，缓存和注入都不归我们提醒。
import { useEffect } from "react";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import type { PurityReport } from "@/services";
import { useProvidersStore } from "@/stores";
import { useChannelPurityStore } from "@/stores/useChannelPurityStore";
import { useSessionCostStore } from "@/stores/useSessionCostStore";
import { providerAlerts, providerDefaultAccount, type Provider, type ProviderAccount } from "@/types/provider";
import type { SessionCostSnapshot } from "@/types/sessionCost";

/** 累计提示 token（输入 + 缓存读 + 缓存写）到这个量才判断：开头一两轮本来就是写缓存、读得少。 */
export const CACHE_LOW_MIN_PROMPT_TOKENS = 100_000;
/** 缓存读占提示 token 的比例低于它就提醒。正常转发缓存的会话通常在八九成以上。 */
export const CACHE_LOW_RATIO = 0.3;

export interface CacheLowAlert {
  /** 0–1 */
  ratio: number;
  promptTokens: number;
}

/** 两种 CLI 的快照里 inputTokens 都已不含缓存部分，口径一致。 */
export function cacheLowAlert(snapshot: SessionCostSnapshot | null | undefined): CacheLowAlert | null {
  if (!snapshot || snapshot.status !== "ready") return null;
  const promptTokens = snapshot.inputTokens + snapshot.cacheReadTokens + snapshot.cacheWriteTokens;
  if (promptTokens < CACHE_LOW_MIN_PROMPT_TOKENS) return null;
  const ratio = snapshot.cacheReadTokens / promptTokens;
  return ratio < CACHE_LOW_RATIO ? { ratio, promptTokens } : null;
}

/** 这次启动用的账号，必须是 API key 账号；登录账号或找不到时返回 null。 */
export function apiKeyAccount(provider: Provider, accountId?: string | null): ProviderAccount | null {
  const account = accountId
    ? provider.accounts?.find((candidate) => candidate.id === accountId)
    : providerDefaultAccount(provider);
  return account?.kind === "api_key" ? account : null;
}

/** 报告只对同一账号算数（报告没记账号时按供应商算）。 */
export function injectionAlert(report: PurityReport | undefined, accountId: string): PurityReport | null {
  if (!report || report.verdict !== "injected") return null;
  if (report.accountId && report.accountId !== accountId) return null;
  return report;
}

export interface ProviderAlertState {
  provider: Provider;
  accountId: string;
  cacheLow: CacheLowAlert | null;
  injection: PurityReport | null;
}

export function useProviderAlerts(context: ActiveTerminalContext): ProviderAlertState | null {
  const supported = !context.ssh && (context.cliTool === "claude" || context.cliTool === "codex");
  const provider = useProvidersStore((state) => (
    supported && context.providerId
      ? state.providers.find((candidate) => candidate.id === context.providerId)
      : undefined
  ));
  const account = provider ? apiKeyAccount(provider, context.providerAccountId) : null;
  const settings = provider && account ? providerAlerts(provider) : null;
  const sessionId = context.sessionId;
  // 费用快照由 SessionCostIndicator 轮询，这里只读。
  const snapshot = useSessionCostStore((state) => (
    settings?.cacheLow && sessionId ? state.sessions.get(sessionId)?.snapshot ?? null : null
  ));
  const report = useChannelPurityStore((state) => (settings?.injection && provider ? state.reports[provider.id] : undefined));
  const loaded = useChannelPurityStore((state) => state.loaded);
  const load = useChannelPurityStore((state) => state.load);
  const wantsReports = !!settings?.injection;
  useEffect(() => {
    // 只读本地已存的报告，不触发检测。
    if (wantsReports && !loaded) void load();
  }, [wantsReports, loaded, load]);

  if (!provider || !account || !settings) return null;
  return {
    provider,
    accountId: account.id,
    cacheLow: settings.cacheLow ? cacheLowAlert(snapshot) : null,
    injection: settings.injection ? injectionAlert(report, account.id) : null,
  };
}
