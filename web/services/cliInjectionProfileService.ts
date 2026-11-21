/**
 * CLI 注入能力描述（docs/110 批 0）— 封装 Tauri/API 调用。
 * 静态兜底 `@/lib/cliInjectionProfiles.json` 由 Rust 测试
 * `web_fallback_matches_registry_profiles` 保证与后端注册表逐字段一致。
 */
import fallbackProfiles from "@/lib/cliInjectionProfiles.json";
import type { InjectionProfileMap } from "@/types/cliInjectionProfile";
import { apiGet, invokeOrApi } from "./apiClient";

export const FALLBACK_INJECTION_PROFILES = fallbackProfiles as InjectionProfileMap;

export async function getCliInjectionProfiles(): Promise<InjectionProfileMap> {
  return invokeOrApi<InjectionProfileMap>("get_cli_injection_profiles", undefined, () =>
    apiGet<InjectionProfileMap>("/api/cli-injection-profiles"),
  );
}

// 同步读取走 `@/stores/useCliInjectionProfilesStore` 的 `injectionProfileFor`（启动后是后端实时值）。
