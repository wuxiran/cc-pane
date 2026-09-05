import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScrollArea, ScrollBar } from "./scroll-area";

describe("ScrollArea", () => {
  it("renders children inside the viewport", () => {
    render(
      <ScrollArea>
        <div>scrollable content</div>
      </ScrollArea>,
    );

    const viewport = document.querySelector(
      '[data-slot="scroll-area-viewport"]',
    );
    expect(viewport).toBeInTheDocument();
    expect(screen.getByText("scrollable content")).toBeInTheDocument();
    expect(viewport).toContainElement(screen.getByText("scrollable content"));
  });

  it("merges custom className on the root", () => {
    render(
      <ScrollArea className="h-40 w-40">
        <div>content</div>
      </ScrollArea>,
    );

    expect(document.querySelector('[data-slot="scroll-area"]')).toHaveClass(
      "h-40",
      "w-40",
    );
  });

  it("always renders the default vertical scrollbar with type=always", () => {
    render(
      <ScrollArea type="always">
        <div>content</div>
      </ScrollArea>,
    );

    const scrollbar = document.querySelector(
      '[data-slot="scroll-area-scrollbar"]',
    );
    expect(scrollbar).toBeInTheDocument();
    expect(scrollbar).toHaveAttribute("data-orientation", "vertical");
    // jsdom reports zero sizes, so Radix never mounts the thumb here;
    // thumb rendering is covered by the browser environment.
  });

  it("supports an additional horizontal scrollbar", () => {
    render(
      <ScrollArea type="always">
        <ScrollBar orientation="horizontal" />
        <div>content</div>
      </ScrollArea>,
    );

    const scrollbars = document.querySelectorAll(
      '[data-slot="scroll-area-scrollbar"]',
    );
    const orientations = Array.from(scrollbars).map((node) =>
      node.getAttribute("data-orientation"),
    );
    expect(orientations).toContain("vertical");
    expect(orientations).toContain("horizontal");
  });
});
