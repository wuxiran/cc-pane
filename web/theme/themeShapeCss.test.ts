// @ts-expect-error Tests run in Node; the frontend tsconfig intentionally omits @types/node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_SHAPE_CODES } from "./themeShapes";

const css = readFileSync("web/assets/index.css", "utf8");

function shapeSection(): string {
  const match = css.match(
    /\/\* THEME SHAPES START \*\/([\s\S]*?)\/\* THEME SHAPES END \*\//,
  );
  return match?.[1] ?? "";
}

function shapeBlock(shape: string): string {
  const escaped = shape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`:root\\[data-shape="${escaped}"\\]\\s*\\{([^}]+)\\}`).exec(
    shapeSection(),
  );
  return match?.[1] ?? "";
}

describe("theme shape CSS contract", () => {
  it.each(THEME_SHAPE_CODES)("defines the complete %s token block", (shape) => {
    const block = shapeBlock(shape);
    expect(block).not.toBe("");
    expect(block).toContain("--radius:");
    expect(block).toContain("--shape-radius-sm:");
    expect(block).toContain("--shape-radius-md:");
    expect(block).toContain("--shape-radius-lg:");
    expect(block).toContain("--shape-radius-xl:");
    expect(block).toContain("--shape-border-width:");
    expect(block).toContain("--shape-shadow:");
    expect(block).toContain("--shape-backdrop-blur:");
  });

  it("keeps Soft compatible and makes Sharp and Panel square", () => {
    expect(shapeBlock("soft")).toMatch(/--radius:\s*0\.5rem\s*;/);
    expect(shapeBlock("sharp")).toMatch(/--radius:\s*0px\s*;/);
    expect(shapeBlock("panel")).toMatch(/--radius:\s*0px\s*;/);
  });

  it("defines the five semantic surface classes", () => {
    const section = shapeSection();
    for (const className of [
      "shape-chrome",
      "shape-surface",
      "shape-panel",
      "shape-control",
      "shape-input",
    ]) {
      expect(section).toContain(`.${className}`);
    }
  });

  it("builds Glass and Carbon materials only from current theme tokens", () => {
    const section = shapeSection();
    expect(section).toContain(':root[data-shape="glass"]');
    expect(section).toContain(':root[data-shape="carbon"]');
    expect(section).toContain("color-mix(in srgb, var(--app-panel-bg-effective)");
    expect(section).toContain("repeating-linear-gradient");
    expect(section).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
  });

  it("does not sweep business classes or style content canvases", () => {
    const section = shapeSection();
    expect(section).not.toMatch(/\[class[*^$|~]?=/);
    expect(section).not.toMatch(/xterm|monaco|mermaid|terminal-view/i);
  });
});
