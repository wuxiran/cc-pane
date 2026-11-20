import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SolidHouse, SolidSettings } from "./solidIcons";

describe("solid icons", () => {
  it("paints with currentColor through a per-instance mask", () => {
    const { container } = render(
      <>
        <SolidHouse className="a" />
        <SolidHouse className="b" />
        <SolidSettings />
      </>,
    );
    const masks = [...container.querySelectorAll("mask")].map((mask) => mask.id);
    expect(new Set(masks).size).toBe(3);
    for (const id of masks) {
      expect(id).toMatch(/^[a-zA-Z0-9-]+$/);
      const painted = container.querySelector(`rect[mask="url(#${id})"]`);
      expect(painted).toHaveAttribute("fill", "currentColor");
    }
  });
});
