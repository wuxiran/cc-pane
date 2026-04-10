import type { KnownCliTool } from "./terminal";

export type ProviderType =
  | "anthropic"
  | "bedrock"
  | "vertex"
  | "proxy"
  | "config_profile"
  | "open_ai"
  | "gemini"
  | "kimi"
  | "glm"
  | "opencode";

export interface Provider {
  id: string;
  name: string;
  providerType: ProviderType;
  apiKey?: string | null;
  baseUrl?: string | null;
  region?: string | null;
  projectId?: string | null;
  awsProfile?: string | null;
  configDir?: string | null;
  isDefault: boolean;
}

export type ProviderTypeLabelKey =
  | "providerTypeAnthropicLabel"
  | "providerTypeBedrockLabel"
  | "providerTypeVertexLabel"
  | "providerTypeProxyLabel"
  | "providerTypeConfigLabel"
  | "providerTypeOpenAILabel"
  | "providerTypeGeminiLabel"
  | "providerTypeKimiLabel"
  | "providerTypeGlmLabel"
  | "providerTypeOpenCodeLabel";

export type ProviderTypeDescKey =
  | "providerTypeAnthropicDesc"
  | "providerTypeBedrockDesc"
  | "providerTypeVertexDesc"
  | "providerTypeProxyDesc"
  | "providerTypeConfigDesc"
  | "providerTypeOpenAIDesc"
  | "providerTypeGeminiDesc"
  | "providerTypeKimiDesc"
  | "providerTypeGlmDesc"
  | "providerTypeOpenCodeDesc";

export const PROVIDER_TYPE_META: Record<
  ProviderType,
  { labelKey: ProviderTypeLabelKey; descriptionKey: ProviderTypeDescKey; fields: string[] }
> = {
  anthropic: {
    labelKey: "providerTypeAnthropicLabel",
    descriptionKey: "providerTypeAnthropicDesc",
    fields: ["apiKey", "baseUrl"],
  },
  bedrock: {
    labelKey: "providerTypeBedrockLabel",
    descriptionKey: "providerTypeBedrockDesc",
    fields: ["region", "awsProfile"],
  },
  vertex: {
    labelKey: "providerTypeVertexLabel",
    descriptionKey: "providerTypeVertexDesc",
    fields: ["region", "projectId"],
  },
  proxy: {
    labelKey: "providerTypeProxyLabel",
    descriptionKey: "providerTypeProxyDesc",
    fields: ["apiKey", "baseUrl"],
  },
  config_profile: {
    labelKey: "providerTypeConfigLabel",
    descriptionKey: "providerTypeConfigDesc",
    fields: ["configDir"],
  },
  open_ai: {
    labelKey: "providerTypeOpenAILabel",
    descriptionKey: "providerTypeOpenAIDesc",
    fields: ["apiKey", "baseUrl"],
  },
  gemini: {
    labelKey: "providerTypeGeminiLabel",
    descriptionKey: "providerTypeGeminiDesc",
    fields: ["apiKey", "baseUrl"],
  },
  kimi: {
    labelKey: "providerTypeKimiLabel",
    descriptionKey: "providerTypeKimiDesc",
    fields: ["apiKey", "baseUrl"],
  },
  glm: {
    labelKey: "providerTypeGlmLabel",
    descriptionKey: "providerTypeGlmDesc",
    fields: ["apiKey", "baseUrl"],
  },
  opencode: {
    labelKey: "providerTypeOpenCodeLabel",
    descriptionKey: "providerTypeOpenCodeDesc",
    fields: ["apiKey", "baseUrl"],
  },
};

/** Provider 类型与 CLI 工具的兼容映射（单值版本，兼容旧调用） */
export function getCompatibleCliTool(providerType: ProviderType): KnownCliTool {
  switch (providerType) {
    case "open_ai": return "codex";
    case "gemini": return "gemini";
    case "kimi": return "kimi";
    case "glm": return "glm";
    case "opencode": return "opencode";
    default: return "claude";
  }
}

/** Provider 类型与 CLI 工具的兼容映射（多值版本） */
export function getCompatibleCliTools(providerType: ProviderType): KnownCliTool[] {
  switch (providerType) {
    case "anthropic":
    case "bedrock":
    case "vertex":
    case "config_profile":
      return ["claude"];
    case "proxy":
      return ["claude"]; // proxy defaults to claude tab
    case "open_ai":
      return ["codex"];
    case "gemini":
      return ["gemini"];
    case "kimi":
      return ["kimi"];
    case "glm":
      return ["glm"];
    case "opencode":
      return ["opencode"];
  }
}

/** 返回某个 CLI Tool Tab 兼容的 ProviderType 列表 */
export function getProviderTypesForTab(tab: KnownCliTool): ProviderType[] {
  const ALL: ProviderType[] = [
    "anthropic",
    "bedrock",
    "vertex",
    "proxy",
    "config_profile",
    "open_ai",
    "gemini",
    "kimi",
    "glm",
    "opencode",
  ];
  return ALL.filter((pt) => getCompatibleCliTools(pt).includes(tab));
}

/** CLI Tool Tab 定义 */
export const CLI_TOOL_TABS = [
  { id: "claude" as const, labelKey: "tabClaude", accentColor: "#E8590C" },
  { id: "codex" as const, labelKey: "tabCodex", accentColor: "#10A37F" },
  { id: "gemini" as const, labelKey: "tabGemini", accentColor: "#4285F4" },
  { id: "kimi" as const, labelKey: "tabKimi", accentColor: "#F97316" },
  { id: "glm" as const, labelKey: "tabGlm", accentColor: "#2563EB" },
  { id: "opencode" as const, labelKey: "tabOpenCode", accentColor: "#8B5CF6" },
] as const;

export type PresetCategory = "official" | "cloud" | "proxy_intl" | "openai_compat" | "domestic";

export interface ProviderPreset {
  id: string;
  nameKey: string;
  descKey: string;
  category: PresetCategory;
  providerType: ProviderType;
  defaults: Partial<Pick<Provider, "baseUrl" | "region" | "projectId" | "awsProfile">>;
  userFields: string[];
  website?: string;
  accentColor?: string;
  order: number;
  /** Override which CLI tool tab(s) this preset belongs to (e.g. for proxy presets) */
  compatibleCliTools?: KnownCliTool[];
}

export interface ConfigDirInfo {
  path: string;
  hasSettings: boolean;
  hasCredentials: boolean;
  settingsSummary: string | null;
  files: string[];
}
