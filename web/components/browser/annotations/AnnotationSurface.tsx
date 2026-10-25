import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { annotationRect, imagePoint, MAX_ANNOTATIONS, type AnnotationFrame, type AnnotationRect, type BrowserAnnotation } from "./annotationModel";

export default function AnnotationSurface({ frame, annotations, disabled, onAdd }: {
  frame: AnnotationFrame; annotations: BrowserAnnotation[]; disabled: boolean; onAdd: (rect: AnnotationRect) => void;
}) {
  const { t } = useTranslation("browserAnnotations");
  const surface = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const [pending, setPending] = useState<AnnotationRect | null>(null);
  const point = (event: PointerEvent) => surface.current && imagePoint(event.clientX, event.clientY, surface.current.getBoundingClientRect(), frame.width, frame.height);
  const down = (event: PointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0 || annotations.length >= MAX_ANNOTATIONS) return;
    const p = point(event); if (!p) return;
    start.current = { ...p, pointerId: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    const p = point(event); if (start.current?.pointerId !== event.pointerId || !p) return;
    setPending(annotationRect(start.current, p));
  };
  const end = (event: PointerEvent) => {
    const p = point(event); const initial = start.current;
    start.current = null; setPending(null);
    if (!initial || initial.pointerId !== event.pointerId || !p) return;
    const rect = annotationRect(initial, p);
    if (rect.width >= 4 && rect.height >= 4) onAdd(rect);
  };
  return <div ref={surface} className="relative w-full select-none" style={{ maxWidth: frame.width }}>
    <img src={frame.dataUrl} alt={t("frozenImage")} draggable={false} className="block w-full" />
    <svg aria-label={t("drawRegion")} role="img" viewBox={`0 0 ${frame.width} ${frame.height}`} className="absolute inset-0 size-full touch-none cursor-crosshair" onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { start.current = null; setPending(null); }}>
      {annotations.map((item, index) => <g key={item.id} style={{ pointerEvents: "none" }}><rect {...{ x: item.x, y: item.y, width: item.width, height: item.height }} fill="none" stroke="var(--app-status-danger)" strokeWidth={Math.max(2, frame.width / 400)} />
        <circle cx={Math.max(12, item.x)} cy={Math.max(12, item.y)} r={Math.max(12, frame.width / 90)} fill="var(--app-status-danger)" />
        <text x={Math.max(12, item.x)} y={Math.max(12, item.y)} dominantBaseline="central" textAnchor="middle" fill="var(--app-text-on-color, white)" fontSize={Math.max(15, frame.width / 100)}>{index + 1}</text></g>)}
      {pending && <rect {...pending} fill="none" stroke="var(--app-accent)" strokeWidth={Math.max(2, frame.width / 400)} strokeDasharray="8 4" />}
    </svg>
  </div>;
}
