import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
// 经 vitest.config.ts 的别名，这里拿到的就是 shim
import { Circle, Settings, Slash, Star, Trash2, X } from "lucide-react";
import { resolveSolidWeight } from "./solidIconFactory";

const paths = (el: Element | null) => el?.querySelectorAll("path").length ?? 0;

describe("lucide → 实心款映射", () => {
  it("keeps lucide class names, size and aria-hidden", () => {
    const { container } = render(<Trash2 className="h-4 w-4" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveClass("lucide", "lucide-trash-2", "h-4", "w-4");
    expect(svg).toHaveAttribute("viewBox", "0 0 256 256");
    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(paths(svg)).toBeGreaterThan(0);
  });

  it("an aria-label keeps the icon visible to assistive tech", () => {
    const { container } = render(<Settings aria-label="settings" />);
    expect(container.querySelector("svg")).not.toHaveAttribute("aria-hidden");
  });

  it("weight rules preserve the caller's fill intent", () => {
    expect(resolveSolidWeight("fill", undefined, undefined)).toEqual({ weight: "fill" });
    expect(resolveSolidWeight("fill", "none", undefined)).toEqual({ weight: "regular" });
    expect(resolveSolidWeight("bold", "currentColor", undefined)).toEqual({ weight: "fill", fillColor: undefined });
    expect(resolveSolidWeight("bold", "var(--x)", undefined)).toEqual({ weight: "fill", fillColor: "var(--x)" });
    expect(resolveSolidWeight("bold", undefined, "size-2 fill-current")).toEqual({ weight: "fill" });
    expect(resolveSolidWeight("bold", undefined, "fill-none")).toEqual({ weight: "bold" });
  });

  it("a toggled star renders differently on and off", () => {
    const on = render(<Star fill="currentColor" />).container.innerHTML;
    const off = render(<Star fill="none" />).container.innerHTML;
    expect(on).not.toEqual(off);
  });

  it("a colored status dot takes its color from fill", () => {
    const { container } = render(<Circle fill="var(--status)" stroke="none" />);
    expect(container.querySelector("svg")).toHaveAttribute("fill", "var(--status)");
  });

  it("stroke glyphs and unmapped icons still render", () => {
    expect(render(<X />).container.querySelector("svg.lucide-x")).not.toBeNull();
    // 表外图标原样透出 lucide 线框
    expect(render(<Slash />).container.querySelector("svg")).toHaveAttribute("viewBox", "0 0 24 24");
  });
});
