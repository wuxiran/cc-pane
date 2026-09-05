import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Progress } from "./progress";

describe("Progress", () => {
  it("renders a progressbar with value aria attributes", () => {
    render(<Progress value={60} />);

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "60");
    expect(bar).toHaveAttribute("data-state", "loading");
  });

  it("translates the indicator according to the value", () => {
    render(<Progress value={25} />);

    const indicator = document.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toHaveStyle({ transform: "translateX(-75%)" });
  });

  it("supports the indeterminate state", () => {
    render(<Progress value={null} />);

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("data-state", "indeterminate");
    // indeterminate progress must not announce a concrete value
    expect(bar).not.toHaveAttribute("aria-valuenow");

    const indicator = document.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toHaveAttribute("data-state", "indeterminate");
  });

  it("respects a custom max", () => {
    render(<Progress value={5} max={10} />);

    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuemax",
      "10",
    );
  });

  it("merges custom className", () => {
    render(<Progress value={10} className="h-4" />);

    expect(screen.getByRole("progressbar")).toHaveClass("h-4");
  });
});
