import type { CliToolInfo, KnownCliTool } from "@/types/terminal";
import type { ProviderType } from "@/types/provider";

/**
 * Stable fallback used while the adapter capability list is loading.
 *
 * The capability response is asynchronous, so treating a missing entry as
 * compatible with every CLI makes the Provider list/counts jump between tabs
 * on the first render. Keep the known type mapping as the temporary filter;
 * once an adapter reports capabilities, that response remains authoritative.
 */
const FALLBACK_CLI_TO_PROVIDER_TYPES: Record<Exclude<KnownCliTool, "none">, ProviderType[]> = {
  claude: ["anthropic", "bedrock", "vertex", "proxy", "config_profile"],
  codex: ["open_ai"],
  // The Pi family maps these CC-Panes Provider types to its built-in provider
  // slugs. Proxy/config-profile/cursor stay native-only until the adapter can
  // verify a stable translation for them.
  pi: ["anthropic", "bedrock", "vertex", "open_ai", "gemini", "grok"],
  omp: ["anthropic", "bedrock", "vertex", "open_ai", "gemini", "grok"],
  gemini: ["gemini"],
  kimi: ["kimi"],
  glm: ["glm"],
  // OpenCode supports its native config plus OpenAI and Anthropic-compatible
  // providers; keep this aligned with cc-cli-adapters/src/opencode.rs.
  opencode: ["open_ai", "opencode", "anthropic"],
  cursor: ["cursor"],
  grok: ["grok"],
};

function fallbackCompatibleProviderTypes(cliTool: string): ProviderType[] | null {
  if (cliTool === "none") return [];
  if (!(cliTool in FALLBACK_CLI_TO_PROVIDER_TYPES)) return null;
  return FALLBACK_CLI_TO_PROVIDER_TYPES[cliTool as Exclude<KnownCliTool, "none">];
}

export function compatibleProviderTypesForCli(
  cliTool: string,
  tools: CliToolInfo[],
): string[] | null {
  if (cliTool === "none") return [];
  return tools.find((tool) => tool.id === cliTool)?.capabilities?.compatibleProviderTypes ?? null;
}

export function isProviderTypeCompatibleWithCli(
  providerType: ProviderType,
  cliTool: string,
  tools: CliToolInfo[],
): boolean {
  const compatibleTypes = compatibleProviderTypesForCli(cliTool, tools);
  if (compatibleTypes !== null) return compatibleTypes.includes(providerType);

  // Capability discovery is asynchronous. Use the stable built-in mapping
  // until it returns so the first render matches the eventual tab contents.
  const fallbackTypes = fallbackCompatibleProviderTypes(cliTool);
  return fallbackTypes === null || fallbackTypes.includes(providerType);
}

export function compatibleCliToolsForProviderType(
  providerType: ProviderType,
  tools: CliToolInfo[],
  candidates: readonly KnownCliTool[],
): KnownCliTool[] {
  return candidates.filter((cliTool) =>
    isProviderTypeCompatibleWithCli(providerType, cliTool, tools));
}
