// 主流 LLM 模型族常见的单一上下文窗口长度（tokens）。
// 用作「上下文窗口」输入框的预设下拉；选中即写入该数值。
// 上限以 types/provider.ts 的 MIN/MAX_PROVIDER_CONTEXT_WINDOW_TOKENS 为准（1k ~ 10M）。
//
// 命名规则：
// - 「labelKey」挂在 settings i18n 里枚举，方便后续调样式 / 加翻译。
// - 数值是 tokens，单一典型值，不写区间。
// - 顺序由小到大；Gemini 2.5 Pro / Llama 4 Scout 这类「默认 1M+」的特殊值独立成项。
// 数据来源：2025 末–2026 初公开公告值（厂商 API 文档为主）。

/** ProviderModelsEditor 下拉里每个预设使用的 i18n key（settings 命名空间）。 */
export const CONTEXT_WINDOW_LABEL_KEYS = {
  "4k":   "providerContextWindow.4k",
  "8k":   "providerContextWindow.8k",
  "16k":  "providerContextWindow.16k",
  "32k":  "providerContextWindow.32k",
  "64k":  "providerContextWindow.64k",
  "128k": "providerContextWindow.128k",
  "200k": "providerContextWindow.200k",
  "256k": "providerContextWindow.256k",
  "400k": "providerContextWindow.400k",
  "500k": "providerContextWindow.500k",
  "1m":   "providerContextWindow.1m",
  "2m":   "providerContextWindow.2m",
  "10m":  "providerContextWindow.10m",
} as const;

export type ContextWindowPresetSize = keyof typeof CONTEXT_WINDOW_LABEL_KEYS;

export interface ContextWindowPreset {
  /** 预设容量标签枚举 */
  size: ContextWindowPresetSize;
  /** UI 展示文本（settings i18n key） */
  labelKey: string;
  /** 上下文窗口 tokens；用户选中即写入 */
  tokens: number;
  /** 对应一个或多个具体模型族（hover hint 用，可选） */
  familyHint?: string;
}

export const CONTEXT_WINDOW_PRESETS: readonly ContextWindowPreset[] = [
  // 老牌 / 较小模型默认值
  { size: "4k",   labelKey: CONTEXT_WINDOW_LABEL_KEYS["4k"],   tokens: 4_000 },
  { size: "8k",   labelKey: CONTEXT_WINDOW_LABEL_KEYS["8k"],   tokens: 8_000 },
  { size: "16k",  labelKey: CONTEXT_WINDOW_LABEL_KEYS["16k"],  tokens: 16_000 },
  { size: "32k",  labelKey: CONTEXT_WINDOW_LABEL_KEYS["32k"],  tokens: 32_000 },
  // 当前主流档：Claude 4.x / GPT-4.1 / o3-o4 / GLM-4.6 默认弹窗常用值
  { size: "64k",  labelKey: CONTEXT_WINDOW_LABEL_KEYS["64k"],  tokens: 64_000 },
  { size: "128k", labelKey: CONTEXT_WINDOW_LABEL_KEYS["128k"], tokens: 128_000, familyHint: "Kimi K2 / Mistral Large 2 / DeepSeek V3.2 / DeepSeek R1" },
  { size: "200k", labelKey: CONTEXT_WINDOW_LABEL_KEYS["200k"], tokens: 200_000, familyHint: "Claude Opus / Sonnet / Haiku 4（默认）· o3 / o4 · GLM-4.6" },
  // 256K 档：Grok 4 / Qwen3 Max
  { size: "256k", labelKey: CONTEXT_WINDOW_LABEL_KEYS["256k"], tokens: 256_000, familyHint: "Grok 4 · Qwen3 Max" },
  // GPT-5 默认独立档
  { size: "400k", labelKey: CONTEXT_WINDOW_LABEL_KEYS["400k"], tokens: 400_000, familyHint: "GPT-5 默认" },
  // 500K 档
  { size: "500k", labelKey: CONTEXT_WINDOW_LABEL_KEYS["500k"], tokens: 500_000, familyHint: "Mistral / Grok" },
  // 1M+ 高基数：Claude 4.5 enterprise / Gemini 2.5 / Grok 3 / Llama 4 Maverick / GPT-4.1
  { size: "1m",   labelKey: CONTEXT_WINDOW_LABEL_KEYS["1m"],   tokens: 1_000_000, familyHint: "Claude Sonnet 4.5（1M beta）· Gemini 2.5 Pro/Flash · GPT-4.1 · Grok 3 · Llama 4 Maverick" },
  // 2M 极端扩展：Gemini 2.5 Pro 长上下文
  { size: "2m",   labelKey: CONTEXT_WINDOW_LABEL_KEYS["2m"],   tokens: 2_000_000, familyHint: "Gemini 2.5 Pro 长上下文档" },
  // 10M 极端：Llama 4 Scout（卡到 MAX=10M 上限）
  { size: "10m",  labelKey: CONTEXT_WINDOW_LABEL_KEYS["10m"],  tokens: 10_000_000, familyHint: "Llama 4 Scout（10M）" },
] as const;

/** 从数值反查预设（用于 hydrated 模型行的下拉默认选中） */
export function findContextWindowPreset(
  tokens: number | null | undefined,
): ContextWindowPreset | undefined {
  if (tokens == null) return undefined;
  return CONTEXT_WINDOW_PRESETS.find((preset) => preset.tokens === tokens);
}
