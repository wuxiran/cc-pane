import { describe, it, expect } from "vitest";
import { missingApiKey, resolveVoiceProvider, shouldPreferWav } from "./voiceProviders";
import type { VoiceSettings } from "@/types";

function makeVoice(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return {
    enabled: true,
    provider: "dashscope",
    dashscopeApiKey: "",
    region: "cn",
    model: "qwen3-asr-flash",
    mimoApiKey: "",
    mimoBaseUrl: "https://api.xiaomimimo.com/v1",
    mimoModel: "mimo-v2.5",
    customApiKey: "",
    customBaseUrl: "http://127.0.0.1:8080/v1",
    customModel: "whisper-1",
    customPreferWav: false,
    language: null,
    enableItn: false,
    maxRecordSeconds: 60,
    showFloatingButton: true,
    ...overrides,
  };
}

describe("resolveVoiceProvider", () => {
  it("未知/缺失 provider 回落 dashscope", () => {
    expect(resolveVoiceProvider("unknown").id).toBe("dashscope");
    expect(resolveVoiceProvider(undefined).id).toBe("dashscope");
    expect(resolveVoiceProvider("custom").id).toBe("custom");
  });
});

describe("shouldPreferWav", () => {
  it("mimo 恒转 WAV；custom 跟随开关；dashscope 不转", () => {
    expect(shouldPreferWav(makeVoice({ provider: "mimo" }))).toBe(true);
    expect(shouldPreferWav(makeVoice({ provider: "dashscope" }))).toBe(false);
    expect(shouldPreferWav(makeVoice({ provider: "custom", customPreferWav: false }))).toBe(false);
    expect(shouldPreferWav(makeVoice({ provider: "custom", customPreferWav: true }))).toBe(true);
  });
});

describe("missingApiKey", () => {
  it("dashscope/mimo 空 key 判缺失", () => {
    expect(missingApiKey(makeVoice({ provider: "dashscope", dashscopeApiKey: " " }))).toBe(true);
    expect(missingApiKey(makeVoice({ provider: "dashscope", dashscopeApiKey: "sk-x" }))).toBe(false);
    expect(missingApiKey(makeVoice({ provider: "mimo", mimoApiKey: "" }))).toBe(true);
    expect(missingApiKey(makeVoice({ provider: "mimo", mimoApiKey: "mimo-x" }))).toBe(false);
  });

  it("custom 空 key 不判缺失（本地无鉴权服务）", () => {
    expect(missingApiKey(makeVoice({ provider: "custom", customApiKey: "" }))).toBe(false);
  });
});
