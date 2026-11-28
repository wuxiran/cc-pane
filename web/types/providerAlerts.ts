import type { Provider } from "./provider";

/** 供应商级提醒：只看本地会话日志和已有的纯度检测结果，不发请求；订阅登录账号永远不提醒。 */
export interface ProviderAlerts {
  /** 会话缓存命中率明显偏低时提醒。 */
  cacheLow: boolean;
  /** 上次纯度检测发现提示词注入时提醒。 */
  injection: boolean;
}

export const DEFAULT_PROVIDER_ALERTS: ProviderAlerts = { cacheLow: true, injection: true };

export function providerAlerts(provider: Provider): ProviderAlerts {
  return { ...DEFAULT_PROVIDER_ALERTS, ...(provider.alerts ?? {}) };
}
