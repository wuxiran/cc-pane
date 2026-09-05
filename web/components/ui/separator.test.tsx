import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Separator } from "./separator";

describe("Separator", () => {
  it("renders a decorative horizontal separator by default", () => {
    render(<Separator />);

    const separator = document.querySelector('[data-slot="separator"]');
    expect(separator).toBeInTheDocument();
    expect(separator).toHaveAttribute("data-orientation", "horizontal");
    // decorative separators are hidden from assistive technology
    expect(separator).not.toHaveAttribute("role", "separator");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("exposes the separator role when not decorative", () => {
    render(<Separator decorative={false} />);

    const separator = screen.getByRole("separator");
    // horizontal is the ARIA default, so Radix omits aria-orientation
    expect(separator).not.toHaveAttribute("aria-orientation");
  });

  it("supports vertical orientation", () => {
    render(<Separator decorative={false} orientation="vertical" />);

    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("data-orientation", "vertical");
  });

  it("merges custom className", () => {
    render(<Separator className="my-4" />);

    expect(document.querySelector('[data-slot="separator"]')).toHaveClass(
      "my-4",
    );
  });
});
