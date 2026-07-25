import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MarkdownPreview from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  it("renders headings from markdown", () => {
    render(<MarkdownPreview content={"# Hello\n\nSome paragraph"} />);
    expect(screen.getByRole("heading", { level: 1, name: "Hello" })).toBeInTheDocument();
    expect(screen.getByText("Some paragraph")).toBeInTheDocument();
  });

  it("supports GFM extensions such as strikethrough and tables", () => {
    const { container } = render(
      <MarkdownPreview content={"~~gone~~\n\n| a | b |\n| - | - |\n| 1 | 2 |"} />
    );
    expect(container.querySelector("del")).toHaveTextContent("gone");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders empty content without crashing", () => {
    const { container } = render(<MarkdownPreview content="" />);
    expect(container.firstElementChild).not.toBeNull();
  });

  it("对显式语言代码块输出 hljs 高亮 token", () => {
    const md = '```ts\nconst x = "hi";\n```';
    const { container } = render(<MarkdownPreview content={md} />);

    expect(container.querySelectorAll(".hljs-keyword").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".hljs-string").length).toBeGreaterThan(0);
  });

  it("无语言标注的代码块不做猜测高亮", () => {
    const { container } = render(<MarkdownPreview content={"```\nplain block\n```"} />);

    expect(container.querySelector("code")).toBeTruthy();
    expect(container.querySelectorAll("[class*='hljs-']").length).toBe(0);
  });

  it("滚动时回调容器元素（供分栏同步）", () => {
    const onScroll = vi.fn();
    const { container } = render(<MarkdownPreview content="# t" onScroll={onScroll} />);

    fireEvent.scroll(container.firstElementChild!);

    expect(onScroll).toHaveBeenCalledWith(container.firstElementChild);
  });
});
