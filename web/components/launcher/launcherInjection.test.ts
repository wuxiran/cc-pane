import { describe, expect, it } from "vitest";
import {
  appendInjection,
  clampInjection,
  INJECTION_MAX_BYTES,
} from "./launcherInjection";

describe("clampInjection", () => {
  it("上限内原样返回", () => {
    const { text, truncated } = clampInjection("hello");
    expect(text).toBe("hello");
    expect(truncated).toBe(false);
  });

  it("超过 8KB 按字节截断并标记 truncated", () => {
    const content = "a".repeat(INJECTION_MAX_BYTES + 100);
    const { text, truncated } = clampInjection(content);
    expect(truncated).toBe(true);
    expect(new TextEncoder().encode(text).length).toBe(INJECTION_MAX_BYTES);
  });

  it("截断落在多字节字符中间时不产生 U+FFFD 残片", () => {
    // 中文 3 字节/字：8192/3 不整除，末字符必被切断
    const content = "汉".repeat(INJECTION_MAX_BYTES);
    const { text, truncated } = clampInjection(content);
    expect(truncated).toBe(true);
    expect(text.includes("�")).toBe(false);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(INJECTION_MAX_BYTES);
  });
});

describe("appendInjection", () => {
  it("已有内容为空时直接返回注入内容", () => {
    expect(appendInjection("", "abc")).toBe("abc");
    expect(appendInjection("  ", "abc")).toBe("abc");
  });

  it("注入内容为空时保留原内容", () => {
    expect(appendInjection("base", "  ")).toBe("base");
  });

  it("两者非空时用空行拼接", () => {
    expect(appendInjection("base", "add")).toBe("base\n\nadd");
  });
});
