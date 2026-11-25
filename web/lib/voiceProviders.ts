// 语音 provider 能力表：设置表单（VoiceSection）与录音链路（VoiceInputButton）
// 的唯一事实源。与 Rust 侧 settings.rs 的 provider 白名单有镜像守卫测试
// （voiceProviderContract.test.ts），加/删 provider 必须两侧同步。
import type { VoiceSettings } from "@/types";

export const VOICE_PROVIDER_IDS = ["dashscope", "mimo", "custom", "local"] as const;
export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[number];
/** 走网络 API 的服务；"local" 是本机 sherpa-onnx，没有密钥/地址，配置见 LocalModelDialog */
export const REMOTE_VOICE_PROVIDER_IDS = ["dashscope", "mimo", "custom"] as const;
export type RemoteVoiceProviderId = (typeof REMOTE_VOICE_PROVIDER_IDS)[number];
export const LOCAL_VOICE_PROVIDER = "local";
export const DEFAULT_VOICE_PROVIDER: RemoteVoiceProviderId = "dashscope";

// Rust 侧 default_voice_custom_* 的镜像（守卫测试比对）
export const DEFAULT_VOICE_CUSTOM_BASE_URL = "http://127.0.0.1:8080/v1";
export const DEFAULT_VOICE_CUSTOM_MODEL = "whisper-1";

export interface VoiceProviderCapability {
  id: RemoteVoiceProviderId;
  // i18n key 字段用字面量联合，保住 settings 命名空间 t() 的键类型检查
  labelKey: "voiceProviderDashscope" | "voiceProviderMimo" | "voiceProviderCustom";
  apiKeyField: "dashscopeApiKey" | "mimoApiKey" | "customApiKey";
  /** custom 为 false：本地 whisper.cpp server 等无鉴权服务允许留空 */
  apiKeyRequired: boolean;
  /** 无本地化需求时的纯技术占位符（如 "sk-..."） */
  apiKeyPlaceholder?: string;
  /** 有需本地化文案时的 i18n key（设置命名空间，优先于 apiKeyPlaceholder） */
  apiKeyPlaceholderKey?: "voiceApiKeyPlaceholderHint";
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

export const VOICE_PROVIDERS: Record<RemoteVoiceProviderId, VoiceProviderCapability> = {
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
    apiKeyPlaceholderKey: "voiceApiKeyPlaceholderHint",
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

/** 远端服务的能力表；"local" 与未知值回落默认服务（本地分支调用方先用 isLocalVoice 判断） */
export function resolveVoiceProvider(provider: string | undefined): VoiceProviderCapability {
  return VOICE_PROVIDERS[(provider ?? "") as RemoteVoiceProviderId] ?? VOICE_PROVIDERS[DEFAULT_VOICE_PROVIDER];
}

export function isLocalVoice(voice: Pick<VoiceSettings, "provider"> | undefined): boolean {
  return voice?.provider === LOCAL_VOICE_PROVIDER;
}

/** 本机识别要 16kHz 单声道 WAV（体积小、免重采样）；远端服务保留原采样率 */
export function wavSampleRate(voice: VoiceSettings | undefined): number | undefined {
  return isLocalVoice(voice) ? 16_000 : undefined;
}

/** mimo、local 恒转 WAV（服务端/引擎不吃 webm/opus）；custom 由用户开关决定 */
export function shouldPreferWav(voice: VoiceSettings): boolean {
  if (voice.provider === "mimo" || isLocalVoice(voice)) return true;
  if (voice.provider === "custom") return voice.customPreferWav;
  return false;
}

export function missingApiKey(voice: VoiceSettings): boolean {
  if (isLocalVoice(voice)) return false;
  const capability = resolveVoiceProvider(voice.provider);
  if (!capability.apiKeyRequired) return false;
  return !voice[capability.apiKeyField].trim();
}
