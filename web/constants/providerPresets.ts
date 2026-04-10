import type { PresetCategory, ProviderPreset } from "@/types/provider";

export const PRESET_CATEGORIES: { key: PresetCategory; labelKey: string }[] = [
  { key: "official", labelKey: "presetCategoryOfficial" },
  { key: "cloud", labelKey: "presetCategoryCloud" },
  { key: "proxy_intl", labelKey: "presetCategoryProxyIntl" },
  { key: "domestic", labelKey: "presetCategoryDomestic" },
  { key: "openai_compat", labelKey: "presetCategoryOpenAI" },
];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ========== Claude Tab ==========

  // --- official ---
  {
    id: "anthropic_official",
    nameKey: "presetAnthropicName",
    descKey: "presetAnthropicDesc",
    category: "official",
    providerType: "anthropic",
    defaults: {},
    userFields: ["apiKey"],
    website: "https://console.anthropic.com/settings/keys",
    accentColor: "#E8590C",
    order: 0,
  },

  // --- cloud ---
  {
    id: "aws_bedrock",
    nameKey: "presetBedrockName",
    descKey: "presetBedrockDesc",
    category: "cloud",
    providerType: "bedrock",
    defaults: { region: "us-east-1" },
    userFields: ["region", "awsProfile"],
    website: "https://console.aws.amazon.com/bedrock",
    accentColor: "#FF9900",
    order: 10,
  },
  {
    id: "google_vertex",
    nameKey: "presetVertexName",
    descKey: "presetVertexDesc",
    category: "cloud",
    providerType: "vertex",
    defaults: { region: "us-central1" },
    userFields: ["region", "projectId"],
    website: "https://console.cloud.google.com/vertex-ai",
    accentColor: "#4285F4",
    order: 11,
  },

  // --- proxy_intl ---
  {
    id: "openrouter_claude",
    nameKey: "presetOpenRouterName",
    descKey: "presetOpenRouterDesc",
    category: "proxy_intl",
    providerType: "proxy",
    defaults: { baseUrl: "https://openrouter.ai/api/v1" },
    userFields: ["apiKey"],
    website: "https://openrouter.ai/keys",
    accentColor: "#6366F1",
    order: 20,
  },
  {
    id: "oneapi_gateway",
    nameKey: "presetOneAPIName",
    descKey: "presetOneAPIDesc",
    category: "proxy_intl",
    providerType: "proxy",
    defaults: {},
    userFields: ["apiKey", "baseUrl"],
    accentColor: "#6B7280",
    order: 21,
  },
  {
    id: "requesty",
    nameKey: "presetRequestyName",
    descKey: "presetRequestyDesc",
    category: "proxy_intl",
    providerType: "proxy",
    defaults: { baseUrl: "https://router.requesty.ai/v1" },
    userFields: ["apiKey"],
    website: "https://app.requesty.ai",
    accentColor: "#F59E0B",
    order: 22,
  },

  // --- domestic ---
  {
    id: "deepseek_claude",
    nameKey: "presetDeepSeekName",
    descKey: "presetDeepSeekDesc",
    category: "domestic",
    providerType: "proxy",
    defaults: { baseUrl: "https://api.deepseek.com" },
    userFields: ["apiKey"],
    website: "https://platform.deepseek.com/api_keys",
    accentColor: "#0EA5E9",
    order: 30,
  },
  {
    id: "siliconflow_claude",
    nameKey: "presetSiliconFlowName",
    descKey: "presetSiliconFlowDesc",
    category: "domestic",
    providerType: "proxy",
    defaults: { baseUrl: "https://api.siliconflow.cn/v1" },
    userFields: ["apiKey"],
    website: "https://cloud.siliconflow.cn",
    accentColor: "#7C3AED",
    order: 31,
  },

  // ========== Codex Tab ==========

  // --- official ---
  {
    id: "openai_official",
    nameKey: "presetOpenAIName",
    descKey: "presetOpenAIDesc",
    category: "official",
    providerType: "open_ai",
    defaults: {},
    userFields: ["apiKey"],
    website: "https://platform.openai.com/api-keys",
    accentColor: "#10A37F",
    order: 40,
  },

  // --- proxy_intl ---
  {
    id: "openrouter_codex",
    nameKey: "presetOpenRouterCodexName",
    descKey: "presetOpenRouterCodexDesc",
    category: "proxy_intl",
    providerType: "open_ai",
    defaults: { baseUrl: "https://openrouter.ai/api/v1" },
    userFields: ["apiKey"],
    website: "https://openrouter.ai/keys",
    accentColor: "#6366F1",
    order: 41,
  },

  // ========== Gemini Tab ==========

  // --- official ---
  {
    id: "gemini_official",
    nameKey: "presetGeminiName",
    descKey: "presetGeminiDesc",
    category: "official",
    providerType: "gemini",
    defaults: {},
    userFields: ["apiKey"],
    website: "https://aistudio.google.com/apikey",
    accentColor: "#4285F4",
    order: 50,
  },
  {
    id: "kimi_official",
    nameKey: "presetKimiName",
    descKey: "presetKimiDesc",
    category: "official",
    providerType: "kimi",
    defaults: { baseUrl: "https://api.moonshot.cn/v1" },
    userFields: ["apiKey"],
    website: "https://platform.moonshot.cn/console/api-keys",
    accentColor: "#F97316",
    order: 52,
  },
  {
    id: "glm_official",
    nameKey: "presetGlmName",
    descKey: "presetGlmDesc",
    category: "official",
    providerType: "glm",
    defaults: { baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
    userFields: ["apiKey"],
    website: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
    accentColor: "#2563EB",
    order: 53,
  },

  // --- proxy_intl ---
  {
    id: "openrouter_gemini",
    nameKey: "presetOpenRouterGeminiName",
    descKey: "presetOpenRouterGeminiDesc",
    category: "proxy_intl",
    providerType: "gemini",
    defaults: { baseUrl: "https://openrouter.ai/api/v1" },
    userFields: ["apiKey"],
    website: "https://openrouter.ai/keys",
    accentColor: "#6366F1",
    order: 51,
  },

  // ========== OpenCode Tab ==========

  // --- official ---
  {
    id: "opencode_anthropic",
    nameKey: "presetOpenCodeAnthropicName",
    descKey: "presetOpenCodeAnthropicDesc",
    category: "official",
    providerType: "opencode",
    defaults: { baseUrl: "https://api.anthropic.com" },
    userFields: ["apiKey"],
    accentColor: "#E8590C",
    order: 60,
  },
  {
    id: "opencode_openai",
    nameKey: "presetOpenCodeOpenAIName",
    descKey: "presetOpenCodeOpenAIDesc",
    category: "official",
    providerType: "opencode",
    defaults: {},
    userFields: ["apiKey"],
    accentColor: "#10A37F",
    order: 61,
  },

  // --- proxy_intl ---
  {
    id: "opencode_openrouter",
    nameKey: "presetOpenCodeOpenRouterName",
    descKey: "presetOpenCodeOpenRouterDesc",
    category: "proxy_intl",
    providerType: "opencode",
    defaults: { baseUrl: "https://openrouter.ai/api/v1" },
    userFields: ["apiKey"],
    website: "https://openrouter.ai/keys",
    accentColor: "#6366F1",
    order: 62,
  },
];
