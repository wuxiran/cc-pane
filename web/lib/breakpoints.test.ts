import { describe, expect, it } from "vitest";
import {
  BREAKPOINT_ORDER,
  BREAKPOINTS,
  getBreakpoint,
  isAtLeast,
  isBelow,
  isExactly,
} from "./breakpoints";

describe("breakpoints", () => {
  it("与 Tailwind 默认断点对齐", () => {
    expect(BREAKPOINTS).toEqual({ xs: 0, sm: 640, md: 768, lg: 1024, xl: 1280 });
    expect(BREAKPOINT_ORDER).toEqual(["xs", "sm", "md", "lg", "xl"]);
  });

  it.each([
    [0, "xs"],
    [639, "xs"],
    [640, "sm"],
    [767, "sm"],
    [768, "md"],
    [1023, "md"],
    [1024, "lg"],
    [1279, "lg"],
    [1280, "xl"],
    [2560, "xl"],
  ] as const)("getBreakpoint(%i) === %s", (width, expected) => {
    expect(getBreakpoint(width)).toBe(expected);
  });

  it("isAtLeast / isBelow 边界", () => {
    expect(isAtLeast(768, "md")).toBe(true);
    expect(isAtLeast(767, "md")).toBe(false);
    expect(isBelow(767, "md")).toBe(true);
    expect(isBelow(768, "md")).toBe(false);
  });

  it("isExactly 只在档内为真", () => {
    expect(isExactly(700, "sm")).toBe(true);
    expect(isExactly(768, "sm")).toBe(false);
    expect(isExactly(2000, "xl")).toBe(true);
  });
});
