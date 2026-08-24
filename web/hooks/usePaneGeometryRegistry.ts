import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rectToCanvasPosition } from "@/lib/canvasGeometry";
import type { CanvasNodePosition } from "@/types/canvas";

export interface PaneGeometryRegistry {
  containerRef: (element: HTMLDivElement | null) => void;
  register: (nodeId: string, element: HTMLElement | null) => void;
  positions: Record<string, CanvasNodePosition>;
}

export function positionsEqual(
  previous: Record<string, CanvasNodePosition>,
  next: Record<string, CanvasNodePosition>,
): boolean {
  const previousIds = Object.keys(previous);
  const nextIds = Object.keys(next);
  if (previousIds.length !== nextIds.length) return false;
  return nextIds.every((id) => {
    const before = previous[id];
    const after = next[id];
    return Boolean(before) && before.x === after.x && before.y === after.y &&
      before.width === after.width && before.height === after.height;
  });
}

export function usePaneGeometryRegistry(): PaneGeometryRegistry {
  const container = useRef<HTMLDivElement | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const frame = useRef<number | null>(null);
  const [positions, setPositions] = useState<Record<string, CanvasNodePosition>>({});

  const measure = useCallback(() => {
    frame.current = null;
    const root = container.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const next: Record<string, CanvasNodePosition> = {};
    elements.current.forEach((element, nodeId) => {
      next[nodeId] = rectToCanvasPosition(element.getBoundingClientRect(), rootRect);
    });
    setPositions((previous) => positionsEqual(previous, next) ? previous : next);
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(measure);
  }, [measure]);

  const containerRef = useCallback((element: HTMLDivElement | null) => {
    const previous = container.current;
    if (previous && previous !== element) observer.current?.unobserve(previous);
    container.current = element;
    if (element) {
      observer.current?.observe(element);
      scheduleMeasure();
    }
  }, [scheduleMeasure]);

  const register = useCallback((nodeId: string, element: HTMLElement | null) => {
    if (element) {
      const previous = elements.current.get(nodeId);
      if (previous !== element) {
        elements.current.set(nodeId, element);
        observer.current?.observe(element);
      }
    } else {
      const previous = elements.current.get(nodeId);
      if (previous) observer.current?.unobserve(previous);
      elements.current.delete(nodeId);
    }
    scheduleMeasure();
  }, [scheduleMeasure]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(scheduleMeasure);
    if (container.current) observer.current.observe(container.current);
    elements.current.forEach((element) => observer.current?.observe(element));
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      observer.current?.disconnect();
      observer.current = null;
      window.removeEventListener("resize", scheduleMeasure);
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [scheduleMeasure]);

  return useMemo(() => ({ containerRef, register, positions }), [containerRef, register, positions]);
}
