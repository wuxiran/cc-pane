import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
