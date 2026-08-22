import type { KnownCliTool, LaunchEffort } from "./terminal";

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

export interface ProviderModel {
  id: string;
  label?: string | null;
  defaultEffort?: LaunchEffort | null;
  /** 已 token 数字形式存的窗口（用于显示 / context 解析）。 */
  contextWindowTokens?: number | null;
  /**
   * 上下文窗口大小，**字符串形式**，匹配 Claude Code 的 `ANTHROPIC_MODEL` 后缀约定
   * （`[1m]` / `[200k]` / `[500k]` 等）。managed_settings 注入 `--settings` 时按此值
   * 拼 `[<size>]` 后缀到 model id。空 / `"200k"`（默认）不拼，`"custom"` 表示用户自行管 env。
   * 与 `contextWindowTokens` 互补：前者控制注入时形态，后者控制 context 解析。
   */
  contextSize?: string | null;
}

export const MIN_PROVIDER_CONTEXT_WINDOW_TOKENS = 1_000;
export const MAX_PROVIDER_CONTEXT_WINDOW_TOKENS = 10_000_000;

export function isValidProviderContextWindowTokens(
  value: number | null | undefined,
): boolean {
  return value === null || value === undefined || (
    Number.isInteger(value)
    && value >= MIN_PROVIDER_CONTEXT_WINDOW_TOKENS
    && value <= MAX_PROVIDER_CONTEXT_WINDOW_TOKENS
  );
}

/** `contextSize` 字符串反解为 token 数字。空 / "custom" / 不可解析 → 0 表示「未知」。 */
export function contextSizeToTokens(size: string | null | undefined): number {
  const s = (size ?? "").trim().toLowerCase();
  if (s === "" || s === "custom") return 0;
  if (s.endsWith("m")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
  }
  if (s.endsWith("k")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n * 1_000) : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * 把 model id 拼上 `[<size>]` 后缀，匹配 Claude Code 的 ANTHROPIC_MODEL 约定。
 * 空 / "200k" / "custom" / 已带相同后缀 → 不变。
 */
export function applyContextSizeSuffix(model: string, contextSize: string | null | undefined): string {
  const cs = (contextSize ?? "").trim();
  if (cs === "" || cs.toLowerCase() === "200k" || cs.toLowerCase() === "custom") {
    return model;
  }
  const suffix = `[${cs}]`;
  if (model.includes(suffix)) return model;
  return `${model}${suffix}`;
}

/** 从带 `[...]` 后缀的 model 字符串反解 token 数。无后缀 / 不可解析 → 0。 */
export function parseContextWindowFromModel(model: string): number {
  const start = model.lastIndexOf("[");
  if (start < 0) return 0;
  const end = model.indexOf("]", start);
  if (end < 0) return 0;
  return contextSizeToTokens(model.slice(start + 1, end));
}

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
  models?: ProviderModel[];
  defaultModelId?: string | null;
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

/**
 * 「系统环境变量」条目的探测结果（镜像后端 `SystemProviderInfo`）。
 * `envKeys` 只含命中的**变量名**，不含值。
 */
export interface SystemProviderInfo {
  /** 探测到 cc-switch 或宿主 Anthropic 凭证之一 */
  active: boolean;
  /** 探测到 `~/.cc-switch/cc-switch.db` */
  ccSwitch: boolean;
  /** 宿主进程中命中的 Anthropic 环境变量名 */
  envKeys: string[];
  /** 用户已把「系统环境变量」设为默认凭证（持久化状态） */
  defaultIsSystem: boolean;
  /** 每个 CLI 工具对应的持久化默认 Provider id */
  defaultProviderIds: Partial<Record<KnownCliTool, string>>;
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

/** CLI Tool Tab 定义 */
export const CLI_TOOL_TABS = [
  { id: "claude" as const, labelKey: "tabClaude", accentColor: "#E8590C" },
  { id: "codex" as const, labelKey: "tabCodex", accentColor: "#10A37F" },
  { id: "pi" as const, labelKey: "tabPi", accentColor: "#F59E0B" },
  { id: "omp" as const, labelKey: "tabOmp", accentColor: "#EC4899" },
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
