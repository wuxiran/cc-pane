// MCP 页右侧详情：显示这条资源的完整信息和只属于它的操作。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2, Pencil, Play, RotateCw, Square, Trash2, X } from "lucide-react";
import CcpanesMcpCard from "@/components/settings/CcpanesMcpCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { Switch } from "@/components/ui/switch";
import { useDescriptionLang } from "@/hooks/useDescriptionLang";
import { toastErr } from "@/lib/feedback";
import { nativeConfirm } from "@/services/nativeDialog";
import { useSharedMcpStore } from "@/stores";
import { useMcpStore } from "@/stores/useMcpStore";
import { translateError } from "@/utils";
import { entryDetail, type McpLibraryEntry } from "./mcpLibraryModel";
import { mcpStatusOf } from "./resourceCenterModel";
import type { LayerEditorRequest } from "./LayerMcpEditorDialog";

interface McpDetailPanelProps {
  entry: McpLibraryEntry;
  sourceLabel: string;
  onClose: () => void;
  onEditShared: (name: string) => void;
  onEditLayer: (request: LayerEditorRequest) => void;
  onImportUser: () => void;
}

export default function McpDetailPanel({ entry, sourceLabel, onClose, onEditShared, onEditLayer, onImportUser }: McpDetailPanelProps) {
  const { t } = useTranslation("settings");
  const { t: tProviders } = useTranslation("providers");
  const { describe } = useDescriptionLang();
  const startServer = useSharedMcpStore((s) => s.startServer);
  const stopServer = useSharedMcpStore((s) => s.stopServer);
  const restartServer = useSharedMcpStore((s) => s.restartServer);
  const toggleShared = useSharedMcpStore((s) => s.toggleShared);
  const removeShared = useSharedMcpStore((s) => s.removeServer);
  const removeLayer = useMcpStore((s) => s.removeServer);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toastErr(t("resourceCenter.saveFailed", { error: translateError(error) }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const confirmed = await nativeConfirm(t("resourceLibrary.removeConfirm", { name: entry.name }), { kind: "warning" });
    if (!confirmed) return;
    await run(async () => {
      if (entry.kind === "shared") await removeShared(entry.name);
      else if (entry.kind === "layer") await removeLayer(entry.target, entry.name);
    });
    onClose();
  };

  const detail = entryDetail(entry);
  const status = entry.kind === "shared" ? mcpStatusOf(entry.server.status) : null;
  const description =
    entry.kind === "ccpanes" ? tProviders("ccpanesMcpDesc") : entry.kind === "layer" ? describe(entry.config.descriptions) : null;
  const envKeys =
    entry.kind === "shared" ? Object.keys(entry.server.config.env)
      : entry.kind === "layer" ? Object.keys(entry.config.env)
        : entry.kind === "user" ? entry.server.envKeys
          : [];

  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col overflow-hidden border-l"
      style={{ borderColor: "var(--app-border)" }}
      aria-label={entry.name}
      data-testid="mcp-detail-panel"
    >
      <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-4">
        <div className="min-w-0">
          <h2 className="truncate text-[length:var(--text-row)] font-semibold" style={{ color: "var(--app-text-primary)" }}>{entry.name}</h2>
          <p className="mt-0.5 text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>
            {sourceLabel}
            {status && ` · ${t(`mcpStatus.${status.level}`)}`}
          </p>
        </div>
        <IconTooltipButton label={t("resourceLibrary.closeDetail")} className="h-7 w-7 shrink-0" onClick={onClose}>
          <X size={14} />
        </IconTooltipButton>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {description && <p className="text-xs leading-relaxed" style={{ color: "var(--app-text-secondary)" }}>{description}</p>}
        {detail && <p className="select-text break-all font-mono text-[length:var(--text-small)]" style={{ color: "var(--app-text-secondary)" }}>{detail}</p>}
        {status?.reason && <p className="select-text break-all font-mono text-[length:var(--text-small)]" style={{ color: "var(--app-status-danger)" }}>{status.reason}</p>}
        {envKeys.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {envKeys.map((key) => <Badge key={key} variant="outline" className="text-[length:var(--text-micro)]">{key}</Badge>)}
          </div>
        )}

        {entry.kind === "shared" && (
          <>
            <p className="text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("resourceLibrary.endpoint", { port: entry.server.config.port, bridge: entry.server.config.bridgeMode })}
            </p>
            <label className="flex items-center justify-between gap-2 text-xs" style={{ color: "var(--app-text-secondary)" }}>
              {t("sharedMcp.enableShared")}
              <Switch
                checked={entry.server.config.shared}
                onCheckedChange={(checked) => void run(() => toggleShared(entry.name, checked))}
              />
            </label>
            <div className="flex flex-wrap gap-1.5">
              {status?.level === "running" ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => stopServer(entry.name))}><Square size={13} className="mr-1" />{t("mcpStop")}</Button>
              ) : status?.level === "failed" ? null : (
                <Button size="sm" variant="outline" disabled={busy || status?.level === "starting" || !entry.server.config.shared} onClick={() => void run(() => startServer(entry.name))}><Play size={13} className="mr-1" />{t("mcpStart")}</Button>
              )}
              {/* 失败态也要能重启：重启会清零计数，是解除熔断的唯一入口 */}
              {(status?.level === "running" || status?.level === "failed") && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => restartServer(entry.name))}><RotateCw size={13} className="mr-1" />{t("sharedMcp.restart")}</Button>
              )}
              {busy && <Loader2 size={13} className="self-center animate-spin" />}
            </div>
          </>
        )}

        {entry.kind === "ccpanes" && <CcpanesMcpCard />}

        {entry.kind === "layer" && entry.shadowed && (
          <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.shadowedHint")}</p>
        )}
        {entry.kind === "user" && (
          <>
            <p className="text-xs leading-relaxed" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.userHint")}</p>
            {(entry.server.transport !== "stdio") ? (
              <p className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceLibrary.userRemoteHint")}</p>
            ) : (
              <Button size="sm" variant="outline" onClick={onImportUser}><Download size={13} className="mr-1" />{t("resourceLibrary.importUser")}</Button>
            )}
          </>
        )}

        {(entry.kind === "shared" || entry.kind === "layer") && (
          <div className="flex flex-wrap gap-1.5 border-t pt-3" style={{ borderColor: "var(--app-border)" }}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => (entry.kind === "shared"
                ? onEditShared(entry.name)
                : onEditLayer({ target: entry.target, layer: entry.layer, server: { name: entry.name, config: entry.config } }))}
            >
              <Pencil size={13} className="mr-1" />{t("mcpEdit")}
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={13} className="mr-1" />{t("mcpDelete")}
            </Button>
          </div>
        )}
      </div>
    </aside>
  );
}
