import { beforeEach, expect, it, vi } from "vitest";
import { browserService } from "./browserService";
import { agentChatService } from "./agentChatService";
import { screenshotService } from "./screenshotService";
import { filesystemService } from "./filesystemService";
import { captureAnnotationFrame, saveBrowserAnnotation } from "./browserAnnotationService";
import { loadAnnotationImage, renderAnnotationPng } from "@/components/browser/annotations/annotationCanvas";
import type { BrowserPageSnapshot } from "./browserService";

vi.mock("./browserService", () => ({ browserService: { snapshot: vi.fn(), screenshot: vi.fn() } }));
vi.mock("./agentChatService", () => ({ agentChatService: { readImageAttachment: vi.fn() } }));
vi.mock("./screenshotService", () => ({ screenshotService: { saveImageAttachment: vi.fn() } }));
vi.mock("./filesystemService", () => ({ filesystemService: { writeFile: vi.fn() } }));
vi.mock("@/components/browser/annotations/annotationCanvas", () => ({ loadAnnotationImage: vi.fn(), renderAnnotationPng: vi.fn() }));
const page: BrowserPageSnapshot = { pageToken: "snapshot", documentId: "document-one", url: "https://example.test/page", title: "Owned page", text: "", elements: [], truncated: false, viewport: { width: 1000, height: 600 } };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(browserService.snapshot).mockResolvedValue(page);
  vi.mocked(browserService.screenshot).mockResolvedValue("/capture.png");
  vi.mocked(agentChatService.readImageAttachment).mockResolvedValue({ path: "/capture.png", mimeType: "image/png", dataBase64: "original", size: 10 });
  vi.mocked(loadAnnotationImage).mockResolvedValue({ naturalWidth: 2000, naturalHeight: 1200 } as HTMLImageElement);
  vi.mocked(renderAnnotationPng).mockResolvedValue("data:image/png;base64,annotated");
  vi.mocked(screenshotService.saveImageAttachment).mockResolvedValue({ filePath: "/captures/new.png", width: 2000, height: 1300 });
});
it("captures a stable document and records real image dimensions separately from CSS viewport", async () => {
  const frame = await captureAnnotationFrame("browser-one");
  expect(frame).toMatchObject({ sourcePath: "/capture.png", width: 2000, height: 1200, viewport: { width: 1000, height: 600 }, url: page.url });
  expect(browserService.screenshot).toHaveBeenCalledWith("browser-one");
});
it.each([
  { ...page, documentId: "reloaded-at-same-url" },
  { ...page, url: "https://example.test/other" },
  { ...page, viewport: { width: 400, height: 600 } },
])("rejects navigation or resizing during capture", async (after) => {
  vi.mocked(browserService.snapshot).mockResolvedValueOnce(page).mockResolvedValueOnce(after);
  await expect(captureAnnotationFrame("browser-one")).rejects.toThrow("page changed");
  expect(agentChatService.readImageAttachment).not.toHaveBeenCalled();
});
it("saves a new annotated image plus structured notes without embedding the original pixels in metadata", async () => {
  const frame = await captureAnnotationFrame("browser-one");
  const annotations = [{ id: "note", x: 20, y: 30, width: 100, height: 80, note: "Move the label" }];
  const saved = await saveBrowserAnnotation(frame, annotations);
  expect(screenshotService.saveImageAttachment).toHaveBeenCalledWith("annotated");
  expect(saved.metadataPath).toBe("/captures/new.annotations.json");
  const metadata = JSON.parse(vi.mocked(filesystemService.writeFile).mock.calls[0][1]);
  expect(metadata).toMatchObject({ version: 1, annotations, imagePath: "/captures/new.png", source: { sourcePath: "/capture.png", url: page.url } });
  expect(metadata.source).not.toHaveProperty("dataUrl");
  expect(saved.markdown).toContain("Move the label");
});
it("does not report a complete export when metadata fails after image persistence", async () => {
  const frame = await captureAnnotationFrame("browser-one");
  vi.mocked(filesystemService.writeFile).mockRejectedValue(new Error("disk full"));
  await expect(saveBrowserAnnotation(frame, [])).rejects.toThrow("Image saved at /captures/new.png, but annotation metadata could not be saved");
});
