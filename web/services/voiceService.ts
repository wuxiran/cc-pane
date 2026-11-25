import type { VoiceSettings } from "@/types";
import { invokeOrApi } from "./apiClient";

export interface VoiceTranscribeRequest {
  audioBase64: string;
  mimeType: string;
  language?: string | null;
  enableItn?: boolean;
  /** 设置页试转写：用草稿设置，不读已保存配置 */
  settingsOverride?: VoiceSettings;
}

export interface VoiceTranscribeResponse {
  text: string;
  language: string | null;
  emotion: string | null;
  duration: number | null;
}

export type LocalVoiceInstallStage = "engine" | "model" | "extract" | "done" | "error" | "cancelled";

export interface LocalVoiceInstallProgress {
  modelId: string;
  stage: LocalVoiceInstallStage;
  received: number;
  total: number;
  error: string | null;
}

export interface LocalVoiceModelStatus {
  id: string;
  installed: boolean;
  /** 还要下载的字节数（含缺失的引擎）；已安装为 0 */
  downloadSize: number;
  hotwords: boolean;
}

export interface LocalVoiceStatus {
  supported: boolean;
  engineInstalled: boolean;
  models: LocalVoiceModelStatus[];
  install: LocalVoiceInstallProgress | null;
  directory: string;
}

const desktopOnly = async (): Promise<never> => {
  throw new Error("Voice transcription is only available in the desktop app");
};

export const voiceService = {
  async transcribe(request: VoiceTranscribeRequest): Promise<VoiceTranscribeResponse> {
    return invokeOrApi<VoiceTranscribeResponse>("transcribe_voice_input", { request }, desktopOnly);
  },
  /** 本机转写组件（引擎 + 模型）的下载状态 */
  async localStatus(): Promise<LocalVoiceStatus> {
    return invokeOrApi<LocalVoiceStatus>("voice_local_status", undefined, desktopOnly);
  },
  async localInstall(modelId: string): Promise<void> {
    return invokeOrApi<void>("voice_local_install", { modelId }, desktopOnly);
  },
  async localCancelInstall(): Promise<void> {
    return invokeOrApi<void>("voice_local_cancel_install", undefined, desktopOnly);
  },
  async localRemove(modelId: string): Promise<void> {
    return invokeOrApi<void>("voice_local_remove", { modelId }, desktopOnly);
  },
};
