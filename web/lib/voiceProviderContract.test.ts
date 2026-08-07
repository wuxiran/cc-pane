// 语音 provider 允许列表的 Rust↔TS 镜像守卫。
//
// 两份允许列表手工维护：Rust 侧 `VoiceSettings::merge_missing_defaults` 的
// matches! 字面量（settings.rs）与 TS 侧 VOICE_PROVIDER_IDS。漏改任何一侧都是
// 静默回落 dashscope：只加 TS → 保存后 Rust 把 provider 改写回默认落盘；
// 只加 Rust → resolveVoiceProvider 在前端静默回落。没有报错、没有日志。
// 做法照抄 themeShapeRustContract.test.ts：真扫 Rust 源码，而不是抄一份常量自证。
import { describe, it, expect } from "vitest";
// Vite raw import 读源码，避开 node:fs（web 的 tsconfig 不含 node 类型）
import rustSettings from "../../cc-panes-core/src/models/settings.rs?raw";
import {
  DEFAULT_VOICE_CUSTOM_BASE_URL,
  DEFAULT_VOICE_CUSTOM_MODEL,
  DEFAULT_VOICE_PROVIDER,
  VOICE_PROVIDER_IDS,
} from "./voiceProviders";

// 定位到 VoiceSettings 的 matches!：settings.rs 里 merge_missing_defaults 有
// 十来个同名实现，`self.provider.as_str()` 是 voice provider 校验独有的锚点。
function extractRustProviderAllowlist(): string[] {
  const anchor = "self.provider.as_str()";
  const start = rustSettings.indexOf(anchor);
  expect(start, `settings.rs 里找不到 ${anchor}——provider 校验被移动或重写，同步更新本测试`).toBeGreaterThanOrEqual(0);
  const literalsStart = start + anchor.length;
  const end = rustSettings.indexOf(")", literalsStart);
  expect(end).toBeGreaterThan(literalsStart);
  const block = rustSettings.slice(literalsStart, end);
  return [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
}

function extractRustStringDefault(fnName: string): string {
  const match = rustSettings.match(
    new RegExp(`fn ${fnName}\\(\\) -> String \\{\\s*"([^"]+)"\\.to_string\\(\\)`),
  );
  expect(match, `settings.rs 里找不到 ${fnName}——函数被移动或重写，同步更新本测试`).not.toBeNull();
  return match![1];
}

describe("voice provider 允许列表 Rust↔TS 镜像", () => {
  it("Rust matches! 字面量与 VOICE_PROVIDER_IDS 完全一致（顺序无关）", () => {
    const rustProviders = extractRustProviderAllowlist();
    expect(rustProviders.length, "Rust 侧 provider 允许列表为空——抽取锚点失效").toBeGreaterThan(0);
    expect([...rustProviders].sort()).toEqual([...VOICE_PROVIDER_IDS].sort());
  });

  it("Rust default_voice_provider 与 TS DEFAULT_VOICE_PROVIDER 一致", () => {
    expect(extractRustStringDefault("default_voice_provider")).toBe(DEFAULT_VOICE_PROVIDER);
  });

  it("Rust custom 默认值与 TS 常量一致（baseUrl / model）", () => {
    expect(extractRustStringDefault("default_voice_custom_base_url")).toBe(DEFAULT_VOICE_CUSTOM_BASE_URL);
    expect(extractRustStringDefault("default_voice_custom_model")).toBe(DEFAULT_VOICE_CUSTOM_MODEL);
  });
});
