import "@/i18n/browserToolsResources";
import { useState } from "react";
import { GripHorizontal, Maximize2, PanelTop, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { browserService } from "@/services/browserService";
import { startBrowserWindowDrag } from "@/services/browserWindowService";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";

/** The native page starts below this compact strip, so it cannot cover its controls. */
export default function BrowserMiniToolbar({ tabId, title, onError }: {
  tabId: string; title: string; onError: (error: unknown) => void;
}) {
  const { t } = useTranslation("browserTools");
  const [pending, setPending] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    try { await action(); } catch (error) { onError(error); }
    finally { setPending(false); }
  };
  return <div className="flex h-10 shrink-0 items-center justify-end gap-2 bg-[var(--app-content)] px-2" data-testid="browser-mini-toolbar">
    <button type="button" aria-label={t("miniDrag")} title={title || t("untitled")}
      className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[var(--app-text-tertiary)]"
      onPointerDown={(event) => { if (event.button === 0) void startBrowserWindowDrag().catch(onError); }}>
      <GripHorizontal className="size-3.5 shrink-0" /><span className="truncate text-xs">{title || t("untitled")}</span>
    </button>
    <div className="flex shrink-0 items-center gap-0.5 rounded-full border border-[var(--app-border)] bg-[var(--app-sidebar)] p-0.5 shadow-sm">
      <IconTooltipButton label={t("miniRestore")} disabled={pending} className="size-7 rounded-full" onClick={() => void run(() => browserService.setWindowMode(tabId, "window"))}><Maximize2 className="size-3.5" /></IconTooltipButton>
      <IconTooltipButton label={t("returnToPanel")} disabled={pending} className="size-7 rounded-full" onClick={() => void run(() => browserService.reclaim(tabId))}><PanelTop className="size-3.5" /></IconTooltipButton>
      <IconTooltipButton label={t("miniClose")} disabled={pending} className="size-7 rounded-full" onClick={() => void run(() => browserService.reclaim(tabId))}><X className="size-3.5" /></IconTooltipButton>
    </div>
  </div>;
}
