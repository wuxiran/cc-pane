import type { AnnotationFrame, BrowserAnnotation } from "./annotationModel";

export function loadAnnotationImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode the captured browser image"));
    image.src = dataUrl;
  });
}

function wrapText(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const character of paragraph) {
      if (line && context.measureText(line + character).width > width) { lines.push(line); line = ""; }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

function drawMarks(context: CanvasRenderingContext2D, annotations: BrowserAnnotation[], width: number) {
  const unit = Math.max(3, width / 360);
  context.lineWidth = unit;
  context.strokeStyle = "#e5484d";
  annotations.forEach((item, index) => {
    context.strokeRect(item.x, item.y, item.width, item.height);
    const radius = unit * 4.5;
    const x = Math.min(width - radius, Math.max(radius, item.x));
    const y = Math.max(radius, item.y);
    context.fillStyle = "#e5484d";
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#ffffff";
    context.font = `600 ${radius * 1.2}px system-ui`;
    context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(String(index + 1), x, y);
  });
}

/** The saved PNG includes both numbered regions and their written notes. */
export async function renderAnnotationPng(frame: AnnotationFrame, annotations: BrowserAnnotation[]): Promise<string> {
  const image = await loadAnnotationImage(frame.dataUrl);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  const font = Math.max(16, Math.min(28, frame.width / 60));
  const padding = font;
  context.font = `${font}px system-ui`;
  const notes = [frame.url, frame.capturedAt, ...annotations.map((item, index) => `${index + 1}. ${item.note.trim() || "—"}`)];
  const lines = notes.flatMap((text) => wrapText(context, text, Math.max(50, frame.width - padding * 2)));
  const footer = Math.ceil(padding * 2 + lines.length * font * 1.5);
  const height = frame.height + footer;
  if (frame.width * height > 32_000_000 || height > 16_384) throw new Error("The annotated image is too large; reduce the viewport or note length");
  canvas.width = frame.width; canvas.height = height;
  context.drawImage(image, 0, 0);
  drawMarks(context, annotations, frame.width);
  context.fillStyle = "#ffffff"; context.fillRect(0, frame.height, frame.width, footer);
  context.fillStyle = "#202124"; context.font = `${font}px system-ui`;
  context.textAlign = "left"; context.textBaseline = "top";
  lines.forEach((line, index) => context.fillText(line, padding, frame.height + padding + index * font * 1.5));
  return canvas.toDataURL("image/png");
}
