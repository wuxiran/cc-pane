import { useEffect, useRef } from "react";
import { Grip } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useBrowserWebviewOverlayStore } from "@/stores/useBrowserWebviewOverlayStore";
import type { BrowserPreviewSettings } from "./BrowserViewportToolbar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Hide the native child while dragging so it cannot steal pointer capture. */
export default function BrowserResizeHandle({ tabId, settings, scale, onChange }: {
  tabId: string; settings: BrowserPreviewSettings; scale: number; onChange: (settings: BrowserPreviewSettings) => void;
}) {
  const { t } = useTranslation("browserTools");
  const drag = useRef<{ x: number; y: number; settings: BrowserPreviewSettings; scale: number } | null>(null);
  const source = `browser-resize:${tabId}`;
  const stop = () => { drag.current = null; useBrowserWebviewOverlayStore.getState().setBlocked(source, false); };
  useEffect(() => () => useBrowserWebviewOverlayStore.getState().setBlocked(source, false), [source]);
  return <Tooltip><TooltipTrigger asChild><button type="button" aria-label={t("resizeViewport")}
    className="absolute -bottom-4 -right-4 flex size-5 touch-none items-center justify-center text-[var(--app-text-tertiary)] cursor-nwse-resize"
    onPointerDown={(event) => {
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, settings, scale };
      useBrowserWebviewOverlayStore.getState().setBlocked(source, true);
    }}
    onPointerMove={(event) => {
      const start = drag.current; if (!start) return;
      onChange({ ...start.settings,
        width: Math.max(240, Math.min(3840, Math.round(start.settings.width + (event.clientX - start.x) / start.scale))),
        height: Math.max(240, Math.min(2160, Math.round(start.settings.height + (event.clientY - start.y) / start.scale))) });
    }} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
    onKeyDown={(event) => {
      const change = event.shiftKey ? 10 : 1;
      const deltas: Record<string, [number, number]> = { ArrowLeft: [-change, 0], ArrowRight: [change, 0], ArrowUp: [0, -change], ArrowDown: [0, change] };
      const delta = deltas[event.key]; if (!delta) return; event.preventDefault();
      onChange({ ...settings, width: Math.max(240, Math.min(3840, settings.width + delta[0])), height: Math.max(240, Math.min(2160, settings.height + delta[1])) });
    }}><Grip className="size-4" /></button></TooltipTrigger><TooltipContent>{t("resizeViewport")}</TooltipContent></Tooltip>;
}
