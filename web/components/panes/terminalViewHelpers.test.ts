import { describe, expect, it, vi } from "vitest";

import * as terminalViewHelpers from "./terminalViewHelpers";
import terminalViewSource from "./TerminalView.tsx?raw";

describe("terminal view repaint visibility guard", () => {
  it("does not repaint a hidden terminal", () => {
    const repaint = vi.fn();

    const repainted = terminalViewHelpers.repaintTerminalWhenVisible(
      () => false,
      repaint,
      "window.focus",
    );

    expect(repainted).toBe(false);
    expect(repaint).not.toHaveBeenCalled();
  });

  it("repaints a visible terminal with the original reason", () => {
    const repaint = vi.fn();

    const repainted = terminalViewHelpers.repaintTerminalWhenVisible(
      () => true,
      repaint,
      "window.resize",
    );

    expect(repainted).toBe(true);
    expect(repaint).toHaveBeenCalledWith("window.resize");
  });

  it("routes all Windows window/document repaint events through the visibility guard", () => {
    const handlers = terminalViewSource.match(
      /const handleWindowResize = \(\) => \{[\s\S]*?document\.addEventListener\("visibilitychange", handleVisibilityChange\);/,
    )?.[0];

    expect(handlers).toContain('repaintIfVisible("window.resize")');
    expect(handlers).toContain('repaintIfVisible("window.focus")');
    expect(handlers).toContain('repaintIfVisible("document.visible")');
    expect(handlers).not.toContain("rendererControllerRef.current?.repaint");
  });
});
