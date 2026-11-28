// 「导出到手机」（docs/112 §6）：桌面只看候选与导出码，密钥从不经过前端。
import type { ProviderType } from "./provider";

export type PhoneProtocol = "anthropic" | "openai_chat";

export interface ProviderExportCandidate {
  id: string;
  name: string;
  providerType: ProviderType;
  protocol: PhoneProtocol | null;
  baseUrl: string | null;
  modelCount: number;
  hasKey: boolean;
  /** NO_API_KEY | UNSUPPORTED_TYPE */
  unsupportedReason?: string;
}

export interface ProviderExportTicket {
  code: string;
  expiresAt: string;
  providerCount: number;
}

export interface ProviderExportStatus {
  active: boolean;
  expiresAt: string | null;
  providerCount: number;
  attemptsLeft: number;
}

export const PROVIDER_EXPORT_EVENT = "provider-export-changed";

export interface ProviderExportEvent {
  state: "redeemed" | "cancelled";
  device?: string;
  count?: number;
  reason?: string;
}
