export type ProviderType = "anthropic" | "bedrock" | "vertex" | "proxy";

export interface Provider {
  id: string;
  name: string;
  providerType: ProviderType;
  apiKey?: string | null;
  baseUrl?: string | null;
  region?: string | null;
  projectId?: string | null;
  awsProfile?: string | null;
  isDefault: boolean;
}

export const PROVIDER_TYPE_META: Record<
  ProviderType,
  { label: string; description: string; fields: string[] }
> = {
  anthropic: {
    label: "Anthropic 直连",
    description: "使用 Anthropic 官方 API",
    fields: ["apiKey", "baseUrl"],
  },
  bedrock: {
    label: "AWS Bedrock",
    description: "通过 AWS Bedrock 访问",
    fields: ["region", "awsProfile"],
  },
  vertex: {
    label: "Google Vertex",
    description: "通过 Vertex AI 访问",
    fields: ["region", "projectId"],
  },
  proxy: {
    label: "自定义代理",
    description: "通过第三方 API 代理",
    fields: ["apiKey", "baseUrl"],
  },
};
