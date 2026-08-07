// 语音 provider 能力表：设置表单（VoiceSection）与录音链路（VoiceInputButton）
// 的唯一事实源。与 Rust 侧 settings.rs 的 provider 白名单有镜像守卫测试
// （voiceProviderContract.test.ts），加/删 provider 必须两侧同步。
import type { VoiceSettings } from "@/types";

export const VOICE_PROVIDER_IDS = ["dashscope", "mimo", "custom"] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];
export const DEFAULT_VOICE_PROVIDER: VoiceProviderId = "dashscope";

// Rust 侧 default_voice_custom_* 的镜像（守卫测试比对）
export const DEFAULT_VOICE_CUSTOM_BASE_URL = "http://127.0.0.1:8080/v1";
export const DEFAULT_VOICE_CUSTOM_MODEL = "whisper-1";

export interface VoiceProviderCapability {
  id: VoiceProviderId;
  // i18n key 字段用字面量联合，保住 settings 命名空间 t() 的键类型检查
  labelKey: "voiceProviderDashscope" | "voiceProviderMimo" | "voiceProviderCustom";
  apiKeyField: "dashscopeApiKey" | "mimoApiKey" | "customApiKey";
  /** custom 为 false：本地 whisper.cpp server 等无鉴权服务允许留空 */
  apiKeyRequired: boolean;
  apiKeyPlaceholder: string;
  apiKeyLabelKey: "voiceDashscopeApiKey" | "voiceMimoApiKey" | "voiceCustomApiKey";
  baseUrlField: "mimoBaseUrl" | "customBaseUrl" | null;
  baseUrlLabelKey?: "voiceMimoBaseUrl" | "voiceCustomBaseUrl";
  baseUrlPlaceholder?: string;
  modelField: "model" | "mimoModel" | "customModel";
  modelPlaceholder: string;
  /** 仅 dashscope：cn/intl 地域选择 */
  showRegion: boolean;
  /** 仅 dashscope：ITN 格式规整开关 */
  showEnableItn: boolean;
  /** 仅 custom：录音转 WAV 开关（mimo 恒转 WAV，无需开关） */
  showPreferWavToggle: boolean;
  hintKey: "voiceLimitHint" | "voiceMimoHint" | "voiceCustomHint";
}

export const VOICE_PROVIDERS: Record<VoiceProviderId, VoiceProviderCapability> = {
  dashscope: {
    id: "dashscope",
    labelKey: "voiceProviderDashscope",
    apiKeyField: "dashscopeApiKey",
    apiKeyRequired: true,
    apiKeyPlaceholder: "sk-...",
    apiKeyLabelKey: "voiceDashscopeApiKey",
    baseUrlField: null,
    modelField: "model",
    modelPlaceholder: "qwen3-asr-flash",
    showRegion: true,
    showEnableItn: true,
    showPreferWavToggle: false,
    hintKey: "voiceLimitHint",
  },
  mimo: {
    id: "mimo",
    labelKey: "voiceProviderMimo",
    apiKeyField: "mimoApiKey",
    apiKeyRequired: true,
    apiKeyPlaceholder: "mimo-...",
    apiKeyLabelKey: "voiceMimoApiKey",
    baseUrlField: "mimoBaseUrl",
    baseUrlLabelKey: "voiceMimoBaseUrl",
    baseUrlPlaceholder: "https://api.xiaomimimo.com/v1",
    modelField: "mimoModel",
    modelPlaceholder: "mimo-v2.5",
    showRegion: false,
    showEnableItn: false,
    showPreferWavToggle: false,
    hintKey: "voiceMimoHint",
  },
  custom: {
    id: "custom",
    labelKey: "voiceProviderCustom",
    apiKeyField: "customApiKey",
    apiKeyRequired: false,
    apiKeyPlaceholder: "sk-... / 留空",
    apiKeyLabelKey: "voiceCustomApiKey",
    baseUrlField: "customBaseUrl",
    baseUrlLabelKey: "voiceCustomBaseUrl",
    baseUrlPlaceholder: DEFAULT_VOICE_CUSTOM_BASE_URL,
    modelField: "customModel",
    modelPlaceholder: DEFAULT_VOICE_CUSTOM_MODEL,
    showRegion: false,
    showEnableItn: false,
    showPreferWavToggle: true,
    hintKey: "voiceCustomHint",
  },
};

export function resolveVoiceProvider(provider: string | undefined): VoiceProviderCapability {
  return VOICE_PROVIDERS[(provider ?? "") as VoiceProviderId] ?? VOICE_PROVIDERS[DEFAULT_VOICE_PROVIDER];
}

/** mimo 恒转 WAV（服务端不吃 webm/opus）；custom 由用户开关决定 */
export function shouldPreferWav(voice: VoiceSettings): boolean {
  if (voice.provider === "mimo") return true;
  if (voice.provider === "custom") return voice.customPreferWav;
  return false;
}

export function missingApiKey(voice: VoiceSettings): boolean {
  const capability = resolveVoiceProvider(voice.provider);
  if (!capability.apiKeyRequired) return false;
  return !voice[capability.apiKeyField].trim();
}
