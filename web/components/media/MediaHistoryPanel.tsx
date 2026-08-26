import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, Copy, Link2, LoaderCircle, RotateCcw, StopCircle, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { mediaService } from "@/services/mediaService";
import { latestMediaRun } from "@/stores/useMediaStore";
import { getErrorMessage } from "@/utils";
import type { MediaAsset, MediaInputAssetSelection, MediaKind, MediaNode, MediaRun, MediaRunStatus } from "@/types/media";

interface MediaHistoryPanelProps {
  nodes: MediaNode[];
  refreshToken: number;
  targetKind?: MediaKind;
  onUseOutput?: (selection: MediaInputAssetSelection) => void;
}

function statusIcon(status: MediaRunStatus) {
  if (status === "succeeded") return <CheckCircle2 className="size-3.5" />;
  if (status === "failed") return <XCircle className="size-3.5" />;
  if (status === "canceled") return <StopCircle className="size-3.5" />;
  if (status === "queued") return <Clock3 className="size-3.5" />;
  return <LoaderCircle className="size-3.5 animate-spin" />;
}

function canUseOutputAsInput(sourceKind: MediaKind, targetKind: MediaKind): boolean {
  return sourceKind === "image" || targetKind === "video";
}

function outputAsset(assets: MediaAsset[], kind: MediaKind): MediaAsset | undefined {
  return assets.find((asset) => {
    const role = asset.metadata.role ?? asset.metadata.assetRole;
    return role !== "poster" && asset.mimeType.toLowerCase().startsWith(`${kind}/`);
  });
}

export default function MediaHistoryPanel({ nodes, refreshToken, targetKind, onUseOutput }: MediaHistoryPanelProps) {
  const { t } = useTranslation("media");
  const [runs, setRuns] = useState<Record<string, MediaRun[]>>({});
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const nodeKey = useMemo(() => nodes.map((node) => node.id).sort().join(","), [nodes]);
  const statusLabels: Record<MediaRunStatus, string> = {
    queued: t("queued"),
    submitting: t("submittingStatus"),
    processing: t("processing"),
    downloading: t("downloading"),
    canceling: t("canceling"),
    succeeded: t("succeeded"),
    failed: t("failed"),
    canceled: t("canceled"),
  };

  async function loadRuns() {
    const entries = await Promise.all(nodes.map(async (node) => [node.id, await mediaService.listRuns(node.id, 10)] as const));
    setRuns(Object.fromEntries(entries));
  }

  useEffect(() => { void loadRuns().catch(() => undefined); }, [nodeKey, refreshToken]);

  async function act(run: MediaRun, action: "cancel" | "retry" | "replay") {
    setBusyRunId(run.id);
    try {
      if (action === "cancel") await mediaService.cancelRun(run.id);
      else if (action === "retry") await mediaService.retryRun(run.id);
      else await mediaService.replayRun(run.id);
      await loadRuns();
    } finally {
      setBusyRunId(null);
    }
  }

  async function useOutput(node: MediaNode, run: MediaRun) {
    if (!targetKind || !onUseOutput) return;
    setBusyRunId(run.id);
    try {
      const asset = outputAsset(await mediaService.listAssets(node.workspaceId, run.id), node.kind);
      if (!asset) {
        toast.error(t("generatedOutputUnavailable"));
        return;
      }
      onUseOutput({
        assetId: asset.id,
        sourceNodeId: node.id,
        sourceRunId: run.id,
        mediaKind: node.kind,
        name: typeof asset.metadata.filename === "string" ? asset.metadata.filename : node.title,
        mimeType: asset.mimeType,
      });
    } catch (error) {
      toast.error(t("generatedOutputLoadFailed", { message: getErrorMessage(error) }));
    } finally {
      setBusyRunId(null);
    }
  }

  if (nodes.length === 0) return null;
  return (
    <section className="border-t border-[var(--app-border)] px-3 py-3" data-testid="media-history-panel">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("taskHistory")}</h2><span className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("nodeCount", { count: nodes.length })}</span></div>
      <div className="max-h-44 space-y-1 overflow-y-auto">
        {nodes.slice().reverse().map((node) => {
          const run = latestMediaRun(runs[node.id] ?? []);
          if (!run) return <div key={node.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}><span className="min-w-0 truncate">{node.title}</span><span>{t("notRun")}</span></div>;
          const active = ["queued", "submitting", "processing", "downloading", "canceling"].includes(run.status);
          return <div key={node.id} className="rounded-md border border-[var(--app-border)] px-2 py-1.5"><div className="flex items-center gap-2 text-[10px]"><span style={{ color: run.status === "failed" ? "var(--app-status-danger)" : run.status === "succeeded" ? "var(--app-status-success)" : "var(--app-accent)" }}>{statusIcon(run.status)}</span><span className="min-w-0 flex-1 truncate" style={{ color: "var(--app-text-secondary)" }}>{node.title}</span><span style={{ color: "var(--app-text-tertiary)" }}>{statusLabels[run.status]}</span>{run.progress != null && active ? <span className="tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>{run.progress}%</span> : null}</div>{run.errorMessage ? <p className="mt-1 line-clamp-2 text-[10px]" style={{ color: "var(--app-status-danger)" }}>{run.errorMessage}</p> : null}<div className="mt-1 flex justify-end gap-1">{active && run.status !== "canceling" ? <Button type="button" variant="ghost" size="icon-xs" aria-label={t("cancelTask")} title={t("cancelTask")} disabled={busyRunId === run.id} onClick={() => void act(run, "cancel")}><StopCircle aria-hidden="true" /></Button> : null}{(run.status === "failed" || run.status === "canceled") ? <Button type="button" variant="ghost" size="icon-xs" aria-label={t("retryTask")} title={t("retryTask")} disabled={busyRunId === run.id} onClick={() => void act(run, "retry")}><RotateCcw aria-hidden="true" /></Button> : null}{run.status === "succeeded" && targetKind && onUseOutput && canUseOutputAsInput(node.kind, targetKind) ? <Button type="button" variant="ghost" size="icon-xs" aria-label={t("useGeneratedOutput")} title={t("useGeneratedOutput")} disabled={busyRunId === run.id} onClick={() => void useOutput(node, run)}><Link2 aria-hidden="true" /></Button> : null}{run.status === "succeeded" ? <Button type="button" variant="ghost" size="icon-xs" aria-label={t("copyVariant")} title={t("copyVariant")} disabled={busyRunId === run.id} onClick={() => void act(run, "replay")}><Copy aria-hidden="true" /></Button> : null}</div></div>;
        })}
      </div>
    </section>
  );
}
