import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import CanvasAnimationMenu from "./CanvasAnimationMenu";
import { useCanvasDisplayStore } from "@/stores/useCanvasDisplayStore";

describe("CanvasAnimationMenu", () => {
  afterEach(() => {
    useCanvasDisplayStore.setState({ mode: "panel", animationIntensity: "full" });
  });

  it("offers the three visual intensity levels", async () => {
    const user = userEvent.setup();
    render(<CanvasAnimationMenu />);
    await user.click(screen.getByTestId("canvas-animation-menu"));

    expect(screen.getByText("完整动画")).toBeInTheDocument();
    expect(screen.getByText("降低动态效果")).toBeInTheDocument();
    expect(screen.getByText("关闭动画")).toBeInTheDocument();

    await user.click(screen.getByText("降低动态效果"));
    expect(useCanvasDisplayStore.getState().animationIntensity).toBe("reduced");
  });
});
