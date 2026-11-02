import "@/i18n";
import i18n from "i18next";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BrowserAnnotationPanel from "./BrowserAnnotationPanel";
import { captureAnnotationFrame, copyAnnotationReference, saveBrowserAnnotation } from "@/services/browserAnnotationService";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import type { AnnotationFrame } from "@/components/browser/annotations/annotationModel";

vi.mock("@/services/browserAnnotationService", () => ({ captureAnnotationFrame: vi.fn(), saveBrowserAnnotation: vi.fn(), copyAnnotationReference: vi.fn(), copyAnnotationImage: vi.fn() }));
const frame: AnnotationFrame = { dataUrl: "data:image/png;base64,ZmFrZQ==", sourcePath: "/capture.png", width: 1000, height: 600, url: "https://example.test/", title: "Fixture page", capturedAt: "2026-10-25T01:00:00Z", viewport: { width: 500, height: 300 } };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  vi.mocked(captureAnnotationFrame).mockResolvedValue(frame);
  vi.mocked(saveBrowserAnnotation).mockResolvedValue({ filePath: "/saved.png", metadataPath: "/saved.annotations.json", markdown: "Source and notes", dataUrl: "data:image/png;base64,c2F2ZWQ=" });
  class TestPointerEvent extends MouseEvent { pointerId: number; constructor(type: string, values: MouseEventInit & { pointerId?: number } = {}) { super(type, values); this.pointerId = values.pointerId ?? 1; } }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  Element.prototype.setPointerCapture = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, x: 0, y: 0, width: 500, height: 300, right: 500, bottom: 300, toJSON() {} });
});

async function draw() {
  const surface = await screen.findByRole("img", { name: "Drag to mark an annotation region" });
  fireEvent.pointerDown(surface, { clientX: 100, clientY: 80, button: 0, pointerId: 1 });
  fireEvent.pointerMove(surface, { clientX: 200, clientY: 180, pointerId: 1 });
  fireEvent.pointerUp(surface, { clientX: 200, clientY: 180, pointerId: 1 });
}

it("captures a frozen page, maps drawn regions to image pixels, and exports written notes", async () => {
  const view = render(<BrowserAnnotationPanel tabId="browser-1" url={frame.url} onClose={vi.fn()} />);
  expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBeGreaterThan(0);
  await draw();
  fireEvent.change(screen.getByLabelText("Note 1"), { target: { value: "Align this field" } });
  fireEvent.click(screen.getByRole("button", { name: "Save image and notes" }));
  await waitFor(() => expect(saveBrowserAnnotation).toHaveBeenCalledWith(frame, [expect.objectContaining({ x: 200, y: 160, width: 200, height: 200, note: "Align this field" })]));
  expect(await screen.findByRole("status")).toHaveTextContent("Annotated image and metadata saved");
  view.unmount();
  expect(useBrowserWebviewOverlayStore.getState().blockers.size).toBe(0);
});

it("protects unsaved notes and reports clipboard failure without claiming success", async () => {
  const close = vi.fn();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<BrowserAnnotationPanel tabId="browser-1" url={frame.url} onClose={close} />);
  await draw();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(window.confirm).toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  vi.mocked(copyAnnotationReference).mockRejectedValue(new Error("Clipboard unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Copy reference" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Clipboard unavailable");
  expect(screen.queryByText("Image path, source and notes copied")).not.toBeInTheDocument();
});
