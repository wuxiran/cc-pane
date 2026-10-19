import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const loaded = vi.hoisted(() => ({ mobile: vi.fn(), switcher: vi.fn() }));
vi.mock("./MobilePrototypeRoute", () => {
  loaded.mobile();
  return { default: () => <div>mobile route ready</div> };
});
vi.mock("@/components/LayoutSwitcherWindow", () => {
  loaded.switcher();
  return { default: () => <div>switcher route ready</div> };
});
import AuxiliaryRoute from "./AuxiliaryRoute";

describe("auxiliary route loading", () => {
  it("does not import either route when the main app imports the router", () => {
    expect(loaded.mobile).not.toHaveBeenCalled();
    expect(loaded.switcher).not.toHaveBeenCalled();
  });
  it("loads only the selected route and can switch after loading", async () => {
    const view = render(<AuxiliaryRoute mode="layout-switcher" />);
    expect(await screen.findByText("switcher route ready")).toBeVisible();
    expect(loaded.switcher).toHaveBeenCalledTimes(1);
    expect(loaded.mobile).not.toHaveBeenCalled();
    view.rerender(<AuxiliaryRoute mode="mobile-prototype" />);
    expect(await screen.findByText("mobile route ready")).toBeVisible();
    expect(loaded.mobile).toHaveBeenCalledTimes(1);
  });
});
