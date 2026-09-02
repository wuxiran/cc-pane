import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { COMMAND_PALETTE_TOGGLE_EVENT } from "@/components/CommandPalette";
import CommandPaletteButton from "./CommandPaletteButton";

describe("CommandPaletteButton", () => {
  it("opens the command palette without relying on the keyboard shortcut", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    window.addEventListener(COMMAND_PALETTE_TOGGLE_EVENT, onToggle);

    render(
      <TooltipProvider>
        <CommandPaletteButton />
      </TooltipProvider>,
    );
    await user.click(screen.getByRole("button"));

    expect(onToggle).toHaveBeenCalledTimes(1);
    window.removeEventListener(COMMAND_PALETTE_TOGGLE_EVENT, onToggle);
  });
});
