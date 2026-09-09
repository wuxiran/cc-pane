import { describe, expect, it } from "vitest";
import { hasBothLocales, pickLocalized, toDescriptionLocale } from "./localizedText";

describe("localizedText", () => {
  it("toDescriptionLocale 把各种 zh 变体归到 zh-CN，其余归 en", () => {
    expect(toDescriptionLocale("zh-CN")).toBe("zh-CN");
    expect(toDescriptionLocale("zh-Hans")).toBe("zh-CN");
    expect(toDescriptionLocale("en-US")).toBe("en");
    expect(toDescriptionLocale(undefined)).toBe("en");
  });

  it("pickLocalized 先取本语言，再取另一种，最后回落原文", () => {
    const both = { "zh-CN": "中文", en: "English" };
    expect(pickLocalized(both, "zh-CN", "raw")).toBe("中文");
    expect(pickLocalized(both, "en", "raw")).toBe("English");
    expect(pickLocalized({ en: "English" }, "zh-CN", "raw")).toBe("English");
    expect(pickLocalized({ en: "  " }, "zh-CN", "raw")).toBe("raw");
    expect(pickLocalized(undefined, "zh-CN", null)).toBeNull();
  });

  it("hasBothLocales 只有两份都非空才为真", () => {
    expect(hasBothLocales({ "zh-CN": "a", en: "b" })).toBe(true);
    expect(hasBothLocales({ "zh-CN": "a", en: "" })).toBe(false);
    expect(hasBothLocales(null)).toBe(false);
  });
});
