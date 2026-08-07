import { describe, expect, it } from "vitest";
import {
  canonicalThemeShape,
  DEFAULT_THEME_SHAPE,
  THEME_SHAPES,
  THEME_SHAPE_CODES,
} from "./themeShapes";

describe("themeShapes", () => {
  it("defines the six approved shapes in display order", () => {
    expect(THEME_SHAPE_CODES).toEqual([
      "soft",
      "slab",
      "sharp",
      "glass",
      "panel",
      "carbon",
    ]);
    expect(THEME_SHAPES.map((shape) => shape.code)).toEqual(THEME_SHAPE_CODES);
    expect(new Set(THEME_SHAPES.map((shape) => shape.descriptionKey)).size).toBe(6);
  });

  it("keeps soft as the compatibility default", () => {
    expect(DEFAULT_THEME_SHAPE).toBe("soft");
    expect(THEME_SHAPES.find((shape) => shape.code === "soft")?.isDefault).toBe(true);
  });

  it.each([
    [undefined, "soft"],
    [null, "soft"],
    ["", "soft"],
    ["GLASS", "soft"],
    ["glass; color: red", "soft"],
    ["unknown", "soft"],
    ["glass", "glass"],
    ["carbon", "carbon"],
  ])("normalizes %s to %s", (value, expected) => {
    expect(canonicalThemeShape(value)).toBe(expected);
  });

  it("marks only Glass and Carbon as translucent wallpaper companions", () => {
    expect(
      THEME_SHAPES.filter((shape) => shape.traits.translucent).map((shape) => shape.code),
    ).toEqual(["glass", "carbon"]);
    expect(
      THEME_SHAPES.filter((shape) => shape.traits.decorative).map((shape) => shape.code),
    ).toEqual(["carbon"]);
  });
});
