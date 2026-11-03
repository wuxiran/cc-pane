import { afterEach, describe, expect, it } from "vitest";
import { accentForeground, applySystemAccent, clearSystemAccent, isHexColor } from "./systemAccent";

describe("systemAccent", () => {
  afterEach(clearSystemAccent);

  it("按亮度选前景色", () => {
    expect(accentForeground("#0a84ff")).toBe("#ffffff");
    expect(accentForeground("#ffd60a")).toBe("#111827");
  });

  it("只接受 6 位 hex，防止把异常值写进样式", () => {
    expect(isHexColor("#0A84ff")).toBe(true);
    expect(isHexColor("red")).toBe(false);
    expect(isHexColor(null)).toBe(false);
  });

  it("应用后可完整清除", () => {
    const { style } = document.documentElement;
    applySystemAccent("#0a84ff");
    expect(style.getPropertyValue("--app-accent")).toBe("#0a84ff");
    expect(style.getPropertyValue("--primary-foreground")).toBe("#ffffff");
    clearSystemAccent();
    expect(style.getPropertyValue("--app-accent")).toBe("");
    expect(style.getPropertyValue("--app-active-bg")).toBe("");
  });
});
