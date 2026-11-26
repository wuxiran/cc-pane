// 中转纯度检测：对一条供应商的每个型号测提示词注入、套壳、掺假。密钥只在后端用。
import { invokeOrApi } from "./apiClient";

export type PurityVerdict = "clean" | "suspicious" | "injected" | "adulterated" | "inconclusive";
export type PurityProtocol = "anthropic" | "responses" | "chat";
export type PurityJobStage = "running" | "done" | "error" | "cancelled";

export type PurityFindingCode =
  | "hidden_prefix"
  | "echoed_injection"
  | "echoed_something"
  | "fishing_admitted"
  | "fishing_unclear"
  | "oauth_channel"
  | "new_params_rejected"
  | "nonstandard_fields"
  | "self_report_mismatch"
  | "batch_downgrade"
  | "response_model_mismatch"
  | "request_failed";

export interface PurityFinding {
  code: PurityFindingCode;
  /** 原始数据（token 数、回复片段），不翻译。 */
  detail?: string;
}

export interface PurityModelReport {
  model: string;
  verdict: PurityVerdict;
  /** 空 system + "hi" 的输入 token 合计。 */
  promptTokens?: number;
  selfReport?: string;
  findings: PurityFinding[];
}

export interface PurityReport {
  providerId: string;
  accountId?: string;
  protocol: PurityProtocol;
  host: string;
  checkedAt: string;
  verdict: PurityVerdict;
  models: PurityModelReport[];
  findings: PurityFinding[];
}

export interface PurityJob {
  providerId: string;
  stage: PurityJobStage;
  done: number;
  total: number;
  currentModel?: string;
  /** 错误码（PURITY_*）或原文。 */
  error?: string;
}

export interface PurityStatus {
  job: PurityJob | null;
  reports: PurityReport[];
}

const desktopOnly = async (): Promise<never> => {
  throw new Error("Channel purity checks are only available in the desktop app");
};

export const channelPurityService = {
  status(): Promise<PurityStatus> {
    return invokeOrApi<PurityStatus>("channel_purity_status", undefined, desktopOnly);
  },
  start(providerId: string, accountId?: string | null): Promise<void> {
    return invokeOrApi<void>("channel_purity_start", { providerId, accountId: accountId ?? null }, desktopOnly);
  },
  cancel(): Promise<void> {
    return invokeOrApi<void>("channel_purity_cancel", undefined, desktopOnly);
  },
  forget(providerId: string): Promise<void> {
    return invokeOrApi<void>("channel_purity_forget", { providerId }, desktopOnly);
  },
};
