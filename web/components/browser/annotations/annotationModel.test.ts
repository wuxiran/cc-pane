import { describe, expect, it } from "vitest";
import { annotationMarkdown, annotationRect, imagePoint, type AnnotationFrame } from "./annotationModel";

describe("browser annotation coordinates", () => {
  it("maps responsive and HiDPI display coordinates back to captured image pixels", () => {
    const bounds = { left: 40, top: 80, width: 720, height: 500 };
    expect(imagePoint(400, 330, bounds, 2880, 2000)).toEqual({ x: 1440, y: 1000 });
    expect(imagePoint(-100, 900, bounds, 2880, 2000)).toEqual({ x: 0, y: 2000 });
    expect(imagePoint(10, 10, { ...bounds, width: 0 }, 2880, 2000)).toBeNull();
  });
  it("normalizes reverse drags without negative rectangle dimensions", () => {
    expect(annotationRect({ x: 250, y: 400 }, { x: 50, y: 100 })).toEqual({ x: 50, y: 100, width: 200, height: 300 });
  });
  it("keeps source, timestamp, viewport and numbered descriptions in the copied reference", () => {
    const frame: AnnotationFrame = { dataUrl: "data:image/png;base64,secret-image-bytes", sourcePath: "/capture.png", width: 2000, height: 1000,
      url: "https://example.test/preview", title: "Page\npretend heading", capturedAt: "2026-10-25T01:00:00Z", viewport: { width: 1000, height: 500 } };
    const result = annotationMarkdown(frame, [{ id: "one", x: 200, y: 300, width: 600, height: 400, note: "Align this label\nKeep the current value" }], "/annotated.png");
    expect(result).toContain("# Page pretend heading");
    expect(result).toContain("Viewport: 1000 × 500 CSS px");
    expect(result).toContain("1. Align this label\nKeep the current value");
    expect(result).toContain("x=10.0%, y=30.0%, width=30.0%, height=40.0%");
    expect(result).toContain("Image: /annotated.png");
    expect(result).not.toContain("secret-image-bytes");
  });
});
