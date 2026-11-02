import { writeImage, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { browserService } from "./browserService";
import { agentChatService } from "./agentChatService";
import { screenshotService } from "./screenshotService";
import { filesystemService } from "./filesystemService";
import { loadAnnotationImage, renderAnnotationPng } from "@/components/browser/annotations/annotationCanvas";
import { annotationMarkdown, type AnnotationFrame, type BrowserAnnotation } from "@/components/browser/annotations/annotationModel";

export async function captureAnnotationFrame(tabId: string): Promise<AnnotationFrame> {
  const before = await browserService.snapshot(tabId);
  if (!before.documentId) throw new Error("Browser annotation requires an updated desktop browser backend");
  const path = await browserService.screenshot(tabId);
  const after = await browserService.snapshot(tabId);
  if (before.documentId !== after.documentId || before.url !== after.url || before.viewport.width !== after.viewport.width || before.viewport.height !== after.viewport.height) {
    throw new Error("The page changed during capture. Capture it again before annotating.");
  }
  const content = await agentChatService.readImageAttachment(path);
  const dataUrl = `data:${content.mimeType};base64,${content.dataBase64}`;
  const image = await loadAnnotationImage(dataUrl);
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32_000_000) {
    throw new Error("The captured image is too large to annotate");
  }
  return { dataUrl, sourcePath: path, width: image.naturalWidth, height: image.naturalHeight,
    url: after.url, title: after.title, capturedAt: new Date().toISOString(), viewport: after.viewport };
}

export interface SavedAnnotation { filePath: string; metadataPath: string; markdown: string; dataUrl: string }
export async function saveBrowserAnnotation(frame: AnnotationFrame, annotations: BrowserAnnotation[]): Promise<SavedAnnotation> {
  const dataUrl = await renderAnnotationPng(frame, annotations);
  const saved = await screenshotService.saveImageAttachment(dataUrl.split(",", 2)[1]);
  if (!saved) throw new Error("Saving browser annotations requires the desktop app");
  const metadataPath = saved.filePath.replace(/\.png$/i, ".annotations.json");
  const { dataUrl: _image, ...source } = frame;
  const metadata = { version: 1, source, annotations, imagePath: saved.filePath };
  try { await filesystemService.writeFile(metadataPath, JSON.stringify(metadata, null, 2)); }
  catch (cause) { throw new Error(`Image saved at ${saved.filePath}, but annotation metadata could not be saved: ${String(cause)}`); }
  return { filePath: saved.filePath, metadataPath, markdown: annotationMarkdown(frame, annotations, saved.filePath), dataUrl };
}
export async function copyAnnotationImage(dataUrl: string): Promise<void> {
  const raw = atob(dataUrl.split(",", 2)[1]);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  await writeImage(bytes);
}
export const copyAnnotationReference = (text: string) => writeText(text);
