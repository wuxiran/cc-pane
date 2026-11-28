import type { MagpieCatalog, MagpieQuotaReport, MagpieRouteStatus } from "@/types/magpie";
import { invokeIfTauri } from "./runtime";

/**
 * Magpie 网关实况（只读，只连本机 127.0.0.1）。只在桌面端有意义：Web 模式下浏览器不在
 * 运行 Magpie 的那台机器上，直接当「不可用」。任何失败都折成不可用——调用方静默隐藏。
 */
const UNAVAILABLE_ROUTE: MagpieRouteStatus = { available: false, seq: 0, switchCount: 0 };
const UNAVAILABLE_QUOTAS: MagpieQuotaReport = { available: false, quotas: [] };
const UNAVAILABLE_CATALOG: MagpieCatalog = { available: false, groups: [], models: [] };

export const magpieService = {
  /** `waitSecs > 0` 时是长轮询：路由变了（seq 超过 `after`）或等满才返回。 */
  async getSessionRoute(
    ptySessionId: string,
    after?: number,
    waitSecs?: number,
  ): Promise<MagpieRouteStatus> {
    try {
      return (await invokeIfTauri<MagpieRouteStatus>("get_magpie_session_route", {
        ptySessionId,
        after: after ?? null,
        waitSecs: waitSecs ?? null,
      })) ?? UNAVAILABLE_ROUTE;
    } catch {
      return UNAVAILABLE_ROUTE;
    }
  },

  async getProviderQuotas(providerId: string): Promise<MagpieQuotaReport> {
    try {
      return (await invokeIfTauri<MagpieQuotaReport>("get_magpie_provider_quotas", { providerId }))
        ?? UNAVAILABLE_QUOTAS;
    } catch {
      return UNAVAILABLE_QUOTAS;
    }
  },

  async getCatalog(providerId?: string | null): Promise<MagpieCatalog> {
    try {
      return (await invokeIfTauri<MagpieCatalog>("get_magpie_catalog", {
        providerId: providerId ?? null,
      })) ?? UNAVAILABLE_CATALOG;
    } catch {
      return UNAVAILABLE_CATALOG;
    }
  },
};
