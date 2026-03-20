export type ProviderType = "anthropic" | "bedrock" | "vertex" | "proxy" | "config_profile" | "open_ai";

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
  | "providerTypeOpenAILabel";

export type ProviderTypeDescKey =
  | "providerTypeAnthropicDesc"
  | "providerTypeBedrockDesc"
  | "providerTypeVertexDesc"
  | "providerTypeProxyDesc"
  | "providerTypeConfigDesc"
  | "providerTypeOpenAIDesc";

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
};

export interface ConfigDirInfo {
  path: string;
  hasSettings: boolean;
  hasCredentials: boolean;
  settingsSummary: string | null;
  files: string[];
}
