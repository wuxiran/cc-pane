import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TERMINAL_LAYOUT_CHANGED_EVENT } from "@/lib/paneTree";
import { useCanvasDisplayStore } from "@/stores/useCanvasDisplayStore";
import CanvasDisplayToggle from "./CanvasDisplayToggle";

describe("CanvasDisplayToggle", () => {
  beforeEach(() => {
    useCanvasDisplayStore.setState({ mode: "panel", animationIntensity: "full" });
  });

  it("keeps the canvas control in the terminal surface and toggles its display state", () => {
    render(
      <TooltipProvider>
        <CanvasDisplayToggle />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: "显示终端画布" });
    expect(button).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(button);

    expect(useCanvasDisplayStore.getState().mode).toBe("canvas");
    expect(screen.getByRole("button", { name: "隐藏终端画布" })).toHaveAttribute("aria-pressed", "true");
  });

  it("emits a terminal layout signal after changing the display surface", async () => {
    const listener = vi.fn();
    window.addEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, listener);

    render(
      <TooltipProvider>
        <CanvasDisplayToggle />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "显示终端画布" }));

    await waitFor(() => expect(listener).toHaveBeenCalled());
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: { reason: "canvas.mode" },
    });
    window.removeEventListener(TERMINAL_LAYOUT_CHANGED_EVENT, listener);
  });
});
