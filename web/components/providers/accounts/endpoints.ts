// 供应商的多个接口地址在编辑表单里的形态。
//
// 表单里「主接口」仍是原来的「地址」框（FormState.baseUrl），其余接口放在 `endpoints` 里；
// `endpoints` 里主接口那一格不用（保存时以 baseUrl 为准）。主接口随类型 / Codex wire API 变化，
// 镜像后端 `Provider::primary_endpoint_kind`。
import type { Provider, ProviderEndpointKind, ProviderEndpoints, ProviderType } from "@/types/provider";

export const ENDPOINT_KINDS: readonly ProviderEndpointKind[] = ["anthropic", "chat", "responses", "gemini"];

export type EndpointDraft = Record<ProviderEndpointKind, string>;

export const EMPTY_ENDPOINTS: EndpointDraft = { anthropic: "", chat: "", responses: "", gemini: "" };

export function primaryEndpointKind(type: ProviderType, codexWireApi?: string | null): ProviderEndpointKind {
  switch (type) {
    case "open_ai":
      return (codexWireApi ?? "").trim().toLowerCase() === "chat" ? "chat" : "responses";
    case "gemini":
      return "gemini";
    case "kimi":
    case "cursor":
    case "opencode":
    case "grok":
      return "chat";
    default:
      return "anthropic";
  }
}

/** 从已存的供应商拆出主接口与其余接口。旧数据没有 `endpoints` 时，`baseUrl` 就是主接口。 */
export function endpointDraftFromProvider(seed: Provider): { primary: string; others: EndpointDraft } {
  const kind = primaryEndpointKind(seed.providerType, seed.codexWireApi);
  const stored = seed.endpoints ?? {};
  const hasEndpoints = ENDPOINT_KINDS.some((item) => !!stored[item]);
  const others: EndpointDraft = { ...EMPTY_ENDPOINTS };
  for (const item of ENDPOINT_KINDS) {
    if (item !== kind) others[item] = stored[item] ?? "";
  }
  const primary = hasEndpoints ? stored[kind] ?? "" : seed.baseUrl ?? "";
  return { primary, others };
}

/**
 * 主接口从 A 换到 B（改类型 / 改 wire API）：用户填的「地址」跟着走到 B，
 * B 原来的值换到 A 那一格，两个值都不丢。
 */
export function moveEndpointsToPrimary(
  from: ProviderEndpointKind,
  to: ProviderEndpointKind,
  others: EndpointDraft,
): EndpointDraft {
  if (from === to) return others;
  return { ...others, [from]: others[to], [to]: "" };
}

/** 保存用的 `endpoints`：去空白，空的写 null。 */
export function endpointsPayload(
  primaryKind: ProviderEndpointKind,
  primary: string,
  others: EndpointDraft,
): ProviderEndpoints {
  const result: ProviderEndpoints = {};
  for (const kind of ENDPOINT_KINDS) {
    const value = (kind === primaryKind ? primary : others[kind]).trim();
    result[kind] = value || null;
  }
  return result;
}

export function filledOtherEndpointCount(primaryKind: ProviderEndpointKind, others: EndpointDraft): number {
  return ENDPOINT_KINDS.filter((kind) => kind !== primaryKind && others[kind].trim() !== "").length;
}
