import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, X } from "lucide-react";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { portPreviewService } from "@/services/portPreviewService";
import { isTauriRuntime } from "@/services/runtime";
import { usePanesStore } from "@/stores/usePanesStore";
import { usePortPreviewStore } from "@/stores/usePortPreviewStore";
import { handleError, handleErrorSilent } from "@/utils";

/**
 * 正在运行的远程端口预览隧道（docs/116 §B）。没有隧道时不渲染；Web 壳不渲染。
 */
export default function PortPreviewList() {
  const { t } = useTranslation("panes");
  const tunnels = usePortPreviewStore((state) => state.tunnels);
  const refresh = usePortPreviewStore((state) => state.refresh);
  const close = usePortPreviewStore((state) => state.close);
  const enabled = isTauriRuntime();

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const reload = () => void refresh().catch((error) => handleErrorSilent(error, "list port previews"));
    reload();
    void portPreviewService.onChanged(reload).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, refresh]);

  if (!enabled || tunnels.length === 0) return null;

  return (
    <section className="mt-3 flex flex-col gap-1" aria-label={t("portPreview.title")}>
      <div className="px-1 text-[length:var(--text-micro)] font-medium text-[var(--app-text-secondary)]">
        {t("portPreview.title")}
      </div>
      {tunnels.map((tunnel) => {
        const url = `http://127.0.0.1:${tunnel.localPort}/`;
        return (
          <div
            key={tunnel.id}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-[var(--app-hover)]"
          >
            <span className="min-w-0 flex-1 truncate text-[var(--app-text-primary)]">
              {tunnel.sshHost}:{tunnel.remotePort}
            </span>
            <span className="shrink-0 font-mono text-[var(--app-text-tertiary)]">
              :{tunnel.localPort}
            </span>
            <IconTooltipButton
              label={t("portPreview.open")}
              onClick={() => usePanesStore.getState().openBrowser(url, `${tunnel.sshHost}:${tunnel.remotePort}`)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </IconTooltipButton>
            <IconTooltipButton
              label={t("portPreview.close")}
              onClick={() => void close(tunnel.id).catch((error) => handleError(error, "close port preview"))}
            >
              <X className="h-3.5 w-3.5" />
            </IconTooltipButton>
          </div>
        );
      })}
    </section>
  );
}
