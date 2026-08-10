/**
 * ProviderFormPanel 的纯表单数据层：表单形状、空值、Provider ⇄ 表单摊平/回填、
 * `{"env": {...}}` JSON 互转。无 React 依赖，便于单测与复用。
 */
import type { Provider, ProviderModel, ProviderPreset, ProviderType } from "@/types/provider";

export interface FormState {
  name: string;
  providerType: ProviderType;
  apiKey: string;
  baseUrl: string;
  region: string;
  projectId: string;
  awsProfile: string;
  configDir: string;
  models: ProviderModel[];
  defaultModelIndex: number | null;
}

export const emptyForm: FormState = {
  name: "",
  providerType: "anthropic",
  apiKey: "",
  baseUrl: "",
  region: "",
  projectId: "",
  awsProfile: "",
  configDir: "",
  models: [],
  defaultModelIndex: null,
};

export function createInitialForm(
  seed: Provider | null | undefined,
  preset: ProviderPreset | null | undefined,
  fallbackType: ProviderType,
  presetName: string,
): FormState {
  if (seed) return formFromProvider(seed);
  if (preset) {
    return {
      ...emptyForm,
      name: presetName,
      providerType: preset.providerType,
      baseUrl: preset.defaults.baseUrl || "",
      region: preset.defaults.region || "",
      projectId: preset.defaults.projectId || "",
      awsProfile: preset.defaults.awsProfile || "",
    };
  }
  return { ...emptyForm, providerType: fallbackType };
}

/**
 * 把一个既有 Provider 摊平成表单初值。编辑与「复制成新 Provider」共用：
 * 两者的表单内容完全同构，差别只在保存路径（update vs add，见 handleSave 的 saveAsUpdate）。
 */
export function formFromProvider(seed: Provider): FormState {
  const models = seed.models ?? [];
  const defaultIndex = models.findIndex((model) => model.id === seed.defaultModelId);
  return {
    name: seed.name,
    providerType: seed.providerType,
    apiKey: seed.apiKey || "",
    baseUrl: seed.baseUrl || "",
    region: seed.region || "",
    projectId: seed.projectId || "",
    awsProfile: seed.awsProfile || "",
    configDir: seed.configDir || "",
    models: models.map((model) => ({ ...model })),
    defaultModelIndex: models.length === 0 ? null : defaultIndex >= 0 ? defaultIndex : 0,
  };
}

/** 根据 Provider 类型，从表单字段构建 {"env": {...}} JSON 字符串 */
export function buildConfigJson(form: FormState): string {
  const env: Record<string, string> = {};
  switch (form.providerType) {
    case "anthropic":
      if (form.apiKey) env["ANTHROPIC_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["ANTHROPIC_BASE_URL"] = form.baseUrl;
      break;
    case "bedrock":
      env["CLAUDE_CODE_USE_BEDROCK"] = "1";
      if (form.region) env["AWS_REGION"] = form.region;
      if (form.awsProfile) env["AWS_PROFILE"] = form.awsProfile;
      break;
    case "vertex":
      env["CLAUDE_CODE_USE_VERTEX"] = "1";
      if (form.region) env["CLOUD_ML_REGION"] = form.region;
      if (form.projectId) env["ANTHROPIC_VERTEX_PROJECT_ID"] = form.projectId;
      break;
    case "proxy":
      if (form.apiKey) env["ANTHROPIC_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["ANTHROPIC_BASE_URL"] = form.baseUrl;
      break;
    case "open_ai":
      if (form.apiKey) env["CODEX_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["OPENAI_BASE_URL"] = form.baseUrl;
      break;
    case "gemini":
      if (form.apiKey) env["GEMINI_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["GEMINI_API_BASE"] = form.baseUrl;
      break;
    case "kimi":
      if (form.apiKey) env["KIMI_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["KIMI_BASE_URL"] = form.baseUrl;
      break;
    case "glm":
      if (form.apiKey) env["ZAI_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["ZAI_BASE_URL"] = form.baseUrl;
      break;
    case "opencode":
      if (form.apiKey) env["OPENAI_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["OPENAI_BASE_URL"] = form.baseUrl;
      break;
    case "cursor":
      if (form.apiKey) env["CURSOR_API_KEY"] = form.apiKey;
      break;
    case "grok":
      if (form.apiKey) env["XAI_API_KEY"] = form.apiKey;
      if (form.baseUrl) {
        env["GROK_MODELS_BASE_URL"] = form.baseUrl;
        env["GROK_CLI_CHAT_PROXY_BASE_URL"] = form.baseUrl;
      }
      break;
    default:
      break;
  }
  return JSON.stringify({ env }, null, 2);
}

/** 从 JSON 字符串解析 env 对象并回填表单字段 */
export function parseConfigJson(jsonStr: string, providerType: ProviderType): Partial<FormState> | null {
  try {
    const config = JSON.parse(jsonStr);
    const env: Record<string, string> = config?.env || {};
    switch (providerType) {
      case "anthropic":
        return { apiKey: env["ANTHROPIC_API_KEY"] || "", baseUrl: env["ANTHROPIC_BASE_URL"] || "" };
      case "bedrock":
        return { region: env["AWS_REGION"] || "", awsProfile: env["AWS_PROFILE"] || "" };
      case "vertex":
        return { region: env["CLOUD_ML_REGION"] || "", projectId: env["ANTHROPIC_VERTEX_PROJECT_ID"] || "" };
      case "proxy":
        return { apiKey: env["ANTHROPIC_API_KEY"] || "", baseUrl: env["ANTHROPIC_BASE_URL"] || "" };
      case "open_ai":
        return { apiKey: env["CODEX_API_KEY"] || "", baseUrl: env["OPENAI_BASE_URL"] || "" };
      case "gemini":
        return { apiKey: env["GEMINI_API_KEY"] || "", baseUrl: env["GEMINI_API_BASE"] || "" };
      case "kimi":
        return { apiKey: env["KIMI_API_KEY"] || "", baseUrl: env["KIMI_BASE_URL"] || "" };
      case "glm":
        return { apiKey: env["ZAI_API_KEY"] || "", baseUrl: env["ZAI_BASE_URL"] || "" };
      case "opencode":
        return { apiKey: env["OPENAI_API_KEY"] || "", baseUrl: env["OPENAI_BASE_URL"] || "" };
      case "cursor":
        return { apiKey: env["CURSOR_API_KEY"] || "" };
      case "grok":
        return {
          apiKey: env["XAI_API_KEY"] || "",
          baseUrl: env["GROK_MODELS_BASE_URL"] || env["GROK_CLI_CHAT_PROXY_BASE_URL"] || "",
        };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
