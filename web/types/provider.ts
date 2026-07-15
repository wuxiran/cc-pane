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
  | "opencode"
  | "cursor"
  | "grok";

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

/**
 * 合成「系统环境变量」provider 的固定 id（镜像后端 `SYSTEM_PROVIDER_ID`）。
 * 选中它表示不注入任何 provider 环境变量，跟随宿主/cc-switch 当前配置。**不落盘**。
 */
export const SYSTEM_PROVIDER_ID = "__system__";

export function isSystemProvider(id: string | null | undefined): boolean {
  return id === SYSTEM_PROVIDER_ID;
}

/**
 * 构造用于列表展示的合成「系统环境变量」条目。
 * `providerType` 仅为满足类型占位（渲染/启动均按 id 特判，不会读取它）。
 */
export function createSystemProvider(name: string, isDefault = false): Provider {
  return {
    id: SYSTEM_PROVIDER_ID,
    name,
    providerType: "config_profile",
    isDefault,
  };
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
  | "providerTypeOpenCodeLabel"
  | "providerTypeCursorLabel"
  | "providerTypeGrokLabel";

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
  | "providerTypeOpenCodeDesc"
  | "providerTypeCursorDesc"
  | "providerTypeGrokDesc";

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
  cursor: {
    labelKey: "providerTypeCursorLabel",
    descriptionKey: "providerTypeCursorDesc",
    fields: ["apiKey"],
  },
  grok: {
    labelKey: "providerTypeGrokLabel",
    descriptionKey: "providerTypeGrokDesc",
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
    case "cursor": return "cursor";
    case "grok": return "grok";
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
    case "cursor":
      return ["cursor"];
    case "grok":
      return ["grok"];
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
    "cursor",
    "grok",
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
  { id: "cursor" as const, labelKey: "tabCursor", accentColor: "#111827" },
  { id: "grok" as const, labelKey: "tabGrok", accentColor: "#71767B" },
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
