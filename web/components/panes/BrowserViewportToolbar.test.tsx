import "@/i18n/browserToolsResources";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "i18next";
import { TooltipProvider } from "@/components/ui/tooltip";
import BrowserViewportToolbar, { previewScale } from "./BrowserViewportToolbar";
import BrowserResizeHandle from "./BrowserResizeHandle";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";

describe("responsive browser geometry", () => {
  it("fits a real CSS viewport without exceeding the available native surface", () => {
    expect(previewScale({ width: 1440, height: 1000, scale: null }, { width: 820.8, height: 570 })).toBeCloseTo(.57);
    expect(previewScale({ width: 1440, height: 1000, scale: 1 }, { width: 720, height: 600 })).toBe(.5);
  });
  it("rotates dimensions and reports read-back dimensions rather than requested values", () => {
    const onChange = vi.fn();
    render(<TooltipProvider><BrowserViewportToolbar settings={{ width: 1440, height: 1000, scale: null }} actual={{ width: 1439, height: 999, scale: .57 }} onChange={onChange} onClose={() => {}} /></TooltipProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("1439 × 999 · 57%");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("rotate", { ns: "browserTools" }) }));
    expect(onChange).toHaveBeenCalledWith({ width: 1000, height: 1440, scale: null });
  });
  it("supports keyboard resizing and clears native-view blocking on unmount", () => {
    const onChange = vi.fn();
    const view = render(<BrowserResizeHandle tabId="owned" settings={{ width: 1440, height: 1000, scale: null }} scale={.5} onChange={onChange} />);
    const handle = screen.getByRole("button", { name: i18n.t("resizeViewport", { ns: "browserTools" }) });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenCalledWith({ width: 1450, height: 1000, scale: null });
    useBrowserWebviewOverlayStore.getState().setBlocked("browser-resize:owned", true);
    view.unmount();
    expect(useBrowserWebviewOverlayStore.getState().blockers.has("browser-resize:owned")).toBe(false);
  });
});
