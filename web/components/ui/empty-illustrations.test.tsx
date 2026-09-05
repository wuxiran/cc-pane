import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  EMPTY_ILLUSTRATIONS,
  EmptyBoxIllustration,
  EmptyFolderIllustration,
  EmptyHistoryIllustration,
  EmptySearchIllustration,
  EmptyTerminalIllustration,
  ErrorCloudIllustration,
} from "./empty-illustrations";

const ALL_COMPONENTS = [
  EmptyFolderIllustration,
  EmptyTerminalIllustration,
  EmptySearchIllustration,
  EmptyHistoryIllustration,
  EmptyBoxIllustration,
  ErrorCloudIllustration,
];

describe("empty-illustrations", () => {
  it("covers all six semantic names", () => {
    expect(Object.keys(EMPTY_ILLUSTRATIONS).sort()).toEqual([
      "empty-box",
      "empty-folder",
      "empty-history",
      "empty-search",
      "empty-terminal",
      "error-cloud",
    ]);
  });

  it.each(ALL_COMPONENTS)("renders an aria-hidden decorative svg", (Component) => {
    const { container } = render(<Component />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("viewBox", "0 0 96 96");
    expect(svg).toHaveAttribute("data-illustration");
  });

  it.each(ALL_COMPONENTS)("uses currentColor stroke and no raw hex colors", (Component) => {
    const { container } = render(<Component />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    // 禁裸 hex：渲染产物中不得出现 #abc / #aabbcc 等字面颜色
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it.each(ALL_COMPONENTS)("has at least one brand accent node using var(--primary)", (Component) => {
    const { container } = render(<Component />);
    // 点缀节点：stroke 或 fill 走 var(--primary)，与品牌主色桥接
    const accented = container.querySelectorAll(
      '[stroke="var(--primary)"], [fill="var(--primary)"]',
    );
    expect(accented.length).toBeGreaterThanOrEqual(1);
    expect(accented.length).toBeLessThanOrEqual(2);
  });

  it.each(ALL_COMPONENTS)("accepts and applies a className", (Component) => {
    const { container } = render(<Component className="h-24 w-24 text-red-500" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("h-24", "w-24", "text-red-500");
  });

  it("maps every semantic name to its component", () => {
    for (const [name, Component] of Object.entries(EMPTY_ILLUSTRATIONS)) {
      const { container } = render(<Component />);
      expect(container.querySelector("svg")).toHaveAttribute("data-illustration", name);
    }
  });
});
