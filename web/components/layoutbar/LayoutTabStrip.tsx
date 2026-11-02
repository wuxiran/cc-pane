import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useDndContext } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/** Only the cards scroll; the surrounding layout tools remain reachable. */
export default function LayoutTabStrip({ children, activeLayoutId, revealKey }: {
  children: ReactNode;
  activeLayoutId: string;
  revealKey: string;
}) {
  const { t } = useTranslation("panes");
  const viewportId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const { active } = useDndContext();
  const draggingRef = useRef(false);
  draggingRef.current = Boolean(active);
  const reducedMotion = usePrefersReducedMotion();
  const [overflow, setOverflow] = useState(false);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!root || !viewport || !track) return;
    // Compare against space without navigation buttons, so they disappear as
    // soon as the cards fit instead of creating their own persistent overflow.
    setOverflow(track.scrollWidth > root.clientWidth + 1);
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const left = viewport.scrollLeft > 1;
    const right = viewport.scrollLeft < max - 1;
    setEdges((previous) => previous.left === left && previous.right === right ? previous : { left, right });
  }, []);

  const reveal = useCallback((element: HTMLElement) => {
    const viewport = viewportRef.current;
    if (!viewport || !viewport.clientWidth || !viewport.contains(element) || draggingRef.current) return;
    const bounds = viewport.getBoundingClientRect();
    const item = element.getBoundingClientRect();
    let delta = 0;
    if (item.left < bounds.left) delta = item.left - bounds.left;
    else if (item.right > bounds.right) {
      delta = Math.min(item.right - bounds.right, item.left - bounds.left);
    }
    // Avoid scrollIntoView: it can also move the parent page/pane vertically.
    if (delta) viewport.scrollLeft += delta;
    measure();
  }, [measure]);

  const revealActive = useCallback(() => {
    const item = Array.from(trackRef.current?.querySelectorAll<HTMLElement>("[data-layout-id]") ?? [])
      .find((node) => node.dataset.layoutId === activeLayoutId);
    if (item) reveal(item);
  }, [activeLayoutId, reveal]);

  useLayoutEffect(() => {
    revealActive();
    measure();
  }, [revealActive, revealKey, overflow, measure]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const root = rootRef.current;
    const track = trackRef.current;
    if (!viewport || !root || !track) return;
    let previousWidth = viewport.clientWidth;
    const resized = () => {
      if (viewport.clientWidth !== previousWidth) {
        previousWidth = viewport.clientWidth;
        revealActive();
      }
      measure();
    };
    const wheel = (event: WheelEvent) => {
      // Preserve pinch/zoom and native horizontal trackpad scrolling. A native
      // listener also excludes wheel events from portaled context menus.
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
      const next = Math.max(0, Math.min(max, viewport.scrollLeft + event.deltaY * unit));
      if (next === viewport.scrollLeft) return;
      event.preventDefault();
      viewport.scrollLeft = next;
      measure();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resized);
    observer?.observe(root);
    observer?.observe(viewport);
    observer?.observe(track);
    viewport.addEventListener("scroll", measure, { passive: true });
    viewport.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("resize", resized);
    measure();
    return () => {
      observer?.disconnect();
      viewport.removeEventListener("scroll", measure);
      viewport.removeEventListener("wheel", wheel);
      window.removeEventListener("resize", resized);
    };
  }, [measure, revealActive]);

  function scroll(direction: -1 | 1) {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }

  function navigation(direction: -1 | 1) {
    const label = t(direction < 0 ? "scrollLayoutsLeft" : "scrollLayoutsRight");
    const Icon = direction < 0 ? ChevronLeft : ChevronRight;
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-controls={viewportId}
        disabled={direction < 0 ? !edges.left : !edges.right}
        className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md hover:bg-[var(--app-hover)] disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]"
        style={{ color: "var(--app-text-secondary)" }}
        onClick={() => scroll(direction)}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div ref={rootRef} data-testid="layout-strip" className="flex min-w-0 flex-1 items-center gap-1 self-stretch">
      {overflow ? navigation(-1) : null}
      <div
        ref={viewportRef}
        id={viewportId}
        data-testid="layout-strip-scroll"
        data-layout-scroll-viewport=""
        className="no-scrollbar min-w-0 flex-1 self-stretch overflow-x-auto overflow-y-hidden"
        onFocusCapture={(event) => reveal(event.target)}
      >
        <div ref={trackRef} data-testid="layout-strip-items" className="inline-flex h-full min-w-max items-center gap-1 px-px">
          {children}
        </div>
      </div>
      {overflow ? navigation(1) : null}
    </div>
  );
}
