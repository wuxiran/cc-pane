// 中转纯度检测的状态：各供应商最近一次报告 + 正在跑的任务。任务在跑时每秒轮询一次。
import { create } from "zustand";
import { channelPurityService, type PurityJob, type PurityReport } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { providerDefaultAccount, providerHasSecret, type Provider } from "@/types/provider";

const POLL_MS = 1000;

/**
 * 能检测的供应商：Claude（Anthropic 接口）或 OpenAI（Responses / Chat），且用的账号是有密钥的 API key 账号。
 * `accountId` 不给时看默认账号（标签页右键时传这次启动用的账号）。
 */
export function purityCheckable(provider: Provider, accountId?: string | null): boolean {
  const account = accountId
    ? provider.accounts?.find((candidate) => candidate.id === accountId)
    : providerDefaultAccount(provider);
  if (!account) return accountId ? false : providerHasSecret(provider);
  if (account.kind !== "api_key" || !account.secretStorage || account.secretStorage === "none") return false;
  const endpoints = provider.endpoints ?? {};
  const has = (value: string | null | undefined) => !!value?.trim();
  switch (provider.providerType) {
    case "anthropic":
    case "proxy":
      return has(endpoints.anthropic) || has(provider.baseUrl);
    case "open_ai":
      return has(endpoints.responses) || has(endpoints.chat) || has(provider.baseUrl);
    default:
      return false;
  }
}

interface ChannelPurityState {
  reports: Record<string, PurityReport>;
  job: PurityJob | null;
  loaded: boolean;
  load: () => Promise<void>;
  start: (providerId: string, accountId?: string | null) => Promise<void>;
  cancel: () => Promise<void>;
  forget: (providerId: string) => Promise<void>;
}

let pollTimer: number | null = null;

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const useChannelPurityStore = create<ChannelPurityState>((set, get) => {
  const syncPolling = () => {
    if (get().job?.stage === "running") {
      if (pollTimer === null) pollTimer = window.setInterval(() => void get().load(), POLL_MS);
    } else {
      stopPolling();
    }
  };

  return {
    reports: {},
    job: null,
    loaded: false,

    async load() {
      if (!isTauriRuntime()) return;
      try {
        const status = await channelPurityService.status();
        set({
          job: status.job,
          reports: Object.fromEntries(status.reports.map((report) => [report.providerId, report])),
          loaded: true,
        });
      } catch (error) {
        console.error("[channel-purity] status failed:", error);
      }
      syncPolling();
    },

    async start(providerId, accountId) {
      await channelPurityService.start(providerId, accountId);
      await get().load();
    },

    async cancel() {
      await channelPurityService.cancel();
      await get().load();
    },

    async forget(providerId) {
      await channelPurityService.forget(providerId);
      await get().load();
    },
  };
});
