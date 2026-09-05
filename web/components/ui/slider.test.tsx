import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Slider } from "./slider";

describe("Slider", () => {
  it("renders a slider thumb with proper aria attributes", () => {
    render(<Slider defaultValue={[40]} min={0} max={100} />);

    const thumb = screen.getByRole("slider");
    expect(thumb).toHaveAttribute("aria-valuemin", "0");
    expect(thumb).toHaveAttribute("aria-valuemax", "100");
    expect(thumb).toHaveAttribute("aria-valuenow", "40");
    expect(thumb).toHaveAttribute("aria-orientation", "horizontal");
  });

  it("renders track and range", () => {
    render(<Slider defaultValue={[40]} />);

    expect(document.querySelector('[data-slot="slider-track"]')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="slider-range"]')).toBeInTheDocument();
  });

  it("changes value with arrow keys", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Slider defaultValue={[50]} onValueChange={onValueChange} />);

    const thumb = screen.getByRole("slider");
    thumb.focus();
    await user.keyboard("{ArrowRight}");

    expect(onValueChange).toHaveBeenCalledWith([51]);
  });

  it("renders one thumb per value for range sliders", () => {
    render(<Slider defaultValue={[20, 80]} />);

    const thumbs = screen.getAllByRole("slider");
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toHaveAttribute("aria-valuenow", "20");
    expect(thumbs[1]).toHaveAttribute("aria-valuenow", "80");
  });

  it("reflects the disabled state", () => {
    render(<Slider defaultValue={[50]} disabled />);

    const root = document.querySelector('[data-slot="slider"]');
    expect(root).toHaveAttribute("data-disabled", "");
    const thumb = screen.getByRole("slider");
    expect(thumb).toHaveAttribute("data-disabled", "");
    expect(thumb).not.toHaveAttribute("tabindex");
  });
});
