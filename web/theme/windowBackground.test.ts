import { describe, expect, it } from "vitest";
import {
  WINDOW_BACKGROUND_DARK,
  WINDOW_BACKGROUND_LIGHT,
  resolveWindowBackgroundColor,
} from "./windowBackground";

describe("resolveWindowBackgroundColor", () => {
  it("uses the active theme's --background when it is a plain hex", () => {
    expect(resolveWindowBackgroundColor(" #1b1920 ", true)).toBe("#1b1920");
    expect(resolveWindowBackgroundColor("#F6F7F9", false)).toBe("#F6F7F9");
  });

  it("falls back by light/dark when the token is missing or not a hex", () => {
    expect(resolveWindowBackgroundColor("", true)).toBe(WINDOW_BACKGROUND_DARK);
    expect(resolveWindowBackgroundColor("", false)).toBe(WINDOW_BACKGROUND_LIGHT);
    expect(resolveWindowBackgroundColor("color-mix(in srgb, red, blue)", false)).toBe(WINDOW_BACKGROUND_LIGHT);
    expect(resolveWindowBackgroundColor("#fff", true)).toBe(WINDOW_BACKGROUND_DARK);
  });
});
