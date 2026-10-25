export interface AnnotationRect { x: number; y: number; width: number; height: number }
export interface BrowserAnnotation extends AnnotationRect { id: string; note: string }
export interface AnnotationFrame {
  dataUrl: string; sourcePath: string; width: number; height: number;
  url: string; title: string; capturedAt: string; viewport: { width: number; height: number };
}
export const MAX_ANNOTATIONS = 20;
export const MAX_NOTE_LENGTH = 1000;

export function imagePoint(clientX: number, clientY: number, bounds: Pick<DOMRect, "left" | "top" | "width" | "height">, width: number, height: number) {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return { x: Math.max(0, Math.min(width, (clientX - bounds.left) * width / bounds.width)),
    y: Math.max(0, Math.min(height, (clientY - bounds.top) * height / bounds.height)) };
}
export function annotationRect(a: { x: number; y: number }, b: { x: number; y: number }): AnnotationRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
const singleLine = (value: string) => value.replace(/[\r\n\u0000-\u001f]/g, " ");
export function annotationMarkdown(frame: AnnotationFrame, annotations: BrowserAnnotation[], imagePath?: string): string {
  const header = [`# ${singleLine(frame.title || "Browser annotations")}`, `URL: ${singleLine(frame.url)}`,
    `Captured: ${frame.capturedAt}`, `Viewport: ${frame.viewport.width} × ${frame.viewport.height} CSS px`];
  if (imagePath) header.push(`Image: ${singleLine(imagePath)}`);
  return [...header, "", ...annotations.map((item, index) => {
    const percent = (value: number, size: number) => (100 * value / size).toFixed(1);
    return `${index + 1}. ${item.note.trim() || "—"}\n   [x=${percent(item.x, frame.width)}%, y=${percent(item.y, frame.height)}%, width=${percent(item.width, frame.width)}%, height=${percent(item.height, frame.height)}%]`;
  })].join("\n");
}
