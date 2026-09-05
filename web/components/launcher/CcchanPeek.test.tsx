import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import CcchanPeek from "./CcchanPeek";

describe("CcchanPeek", () => {
  it("renders an aria-hidden decorative svg", () => {
    const { container } = render(<CcchanPeek />);
    const root = container.querySelector("[data-ccchan-peek]");
    expect(root).toBeInTheDocument();
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("has the breathing float animation class with expected params", () => {
    const { container } = render(<CcchanPeek />);
    const root = container.querySelector("[data-ccchan-peek]");
    // translateY 2px / 2.4s / var(--ease-in-out)：Tailwind 任意值类引用组件内 keyframes
    expect(root).toHaveClass(
      "animate-[ccchan-peek-float_2.4s_var(--ease-in-out)_infinite]",
    );
    // 组件内联注入 keyframes，不改全局 CSS
    expect(container.querySelector("style")?.textContent).toContain(
      "@keyframes ccchan-peek-float",
    );
    expect(container.querySelector("style")?.textContent).toContain(
      "translateY(-2px)",
    );
  });

  it("is static under reduced motion", () => {
    const { container } = render(<CcchanPeek />);
    expect(container.querySelector("[data-ccchan-peek]")).toHaveClass(
      "motion-reduce:animate-none",
    );
  });

  it("uses token colors only (no raw hex)", () => {
    const { container } = render(<CcchanPeek />);
    const svg = container.querySelector("svg");
    expect(svg?.innerHTML).toContain("var(--primary)");
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("accepts and applies a className", () => {
    const { container } = render(<CcchanPeek className="sm:mr-auto" />);
    expect(container.querySelector("[data-ccchan-peek]")).toHaveClass(
      "sm:mr-auto",
    );
  });
});
