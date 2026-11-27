import { useEffect, useState } from "react";
import { magpieService } from "@/services/magpieService";
import type { MagpieCatalog, MagpieQuota, MagpieQuotaReport } from "@/types/magpie";
import type { Provider } from "@/types/provider";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(url.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 前端粗筛：Magpie 导入的、或地址指向本机回环的供应商才值得问一次后端。
 * 是否真指向 Magpie 网关（端口一致）由后端判定，不一致会回「不可用」。
 */
export function mightUseMagpieGateway(provider: Provider | null | undefined): boolean {
  if (!provider) return false;
  if (provider.source?.kind === "magpie") return true;
  const urls = [provider.baseUrl, ...Object.values(provider.endpoints ?? {})];
  return urls.some(isLoopbackUrl);
}

/** 额度卡显示的名字：用户起的别名 → 名称 → 账号。 */
export function magpieQuotaName(quota: MagpieQuota): string {
  return quota.alias?.trim() || quota.name?.trim() || quota.user?.trim() || quota.provider;
}

/** 供应商的 Magpie 额度（Magpie 已缓存的读数）。不可用时返回 null。 */
export function useMagpieQuotas(provider: Provider | null | undefined): MagpieQuotaReport | null {
  const providerId = mightUseMagpieGateway(provider) ? provider?.id ?? null : null;
  const [report, setReport] = useState<MagpieQuotaReport | null>(null);
  useEffect(() => {
    setReport(null);
    if (!providerId) return;
    let cancelled = false;
    void magpieService.getProviderQuotas(providerId).then((next) => {
      if (!cancelled) setReport(next.available ? next : null);
    });
    return () => {
      cancelled = true;
    };
  }, [providerId]);
  return report;
}

/** 选中供应商指向 Magpie 网关时的实时路由组 / 模型；否则 null。 */
export function useMagpieCatalog(provider: Provider | null | undefined): MagpieCatalog | null {
  const providerId = mightUseMagpieGateway(provider) ? provider?.id ?? null : null;
  const [catalog, setCatalog] = useState<MagpieCatalog | null>(null);
  useEffect(() => {
    setCatalog(null);
    if (!providerId) return;
    let cancelled = false;
    void magpieService.getCatalog(providerId).then((next) => {
      if (!cancelled) setCatalog(next.available ? next : null);
    });
    return () => {
      cancelled = true;
    };
  }, [providerId]);
  return catalog;
}
