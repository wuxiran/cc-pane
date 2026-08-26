import { useEffect, useRef, useState } from "react";
import { Cpu, Database, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { mediaService } from "@/services/mediaService";
import { getErrorMessage } from "@/utils";
import type { ComfyDeviceInfo, ComfySystemStats, MediaProtocol } from "@/types";

interface ComfyResourcePanelProps {
  providerId: string | null;
  protocol: MediaProtocol;
}

function formatBytes(value: number | null | undefined): string {
  if (!Number.isFinite(value) || !value || value < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function deviceLabel(device: ComfyDeviceInfo, index: number): string {
  return device.name || `${device.deviceType || "device"} ${device.index ?? index}`;
}

export default function ComfyResourcePanel({ providerId, protocol }: ComfyResourcePanelProps) {
  const { t } = useTranslation("media");
  const [stats, setStats] = useState<ComfySystemStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSerial = useRef(0);

  async function loadStats() {
    if (!providerId || protocol !== "comfyui") return;
    const serial = ++requestSerial.current;
    setLoading(true);
    try {
      const next = await mediaService.getComfySystemStats(providerId);
      if (serial !== requestSerial.current) return;
      setStats(next);
      setError(null);
    } catch (loadError) {
      if (serial !== requestSerial.current) return;
      setError(getErrorMessage(loadError));
    } finally {
      if (serial === requestSerial.current) setLoading(false);
    }
  }

  useEffect(() => {
    requestSerial.current += 1;
    setStats(null);
    setError(null);
    void loadStats();
    // Provider changes are the only automatic refresh trigger; manual refresh
    // keeps remote engines from receiving an unnecessary polling stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, protocol]);

  async function releaseMemory(unloadModels: boolean) {
    if (!providerId) return;
    setBusy(true);
    try {
      await mediaService.freeComfyMemory(providerId, { unloadModels, freeMemory: true });
      await loadStats();
    } catch (releaseError) {
      setError(getErrorMessage(releaseError));
    } finally {
      setBusy(false);
    }
  }

  if (!providerId || protocol !== "comfyui") return null;
  const system = stats?.system;

  return (
    <section className="space-y-1.5 border-t border-[var(--app-border)] pt-2" data-testid="comfy-resource-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px]" style={{ color: "var(--app-text-secondary)" }}>
          <Cpu className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{t("comfyResources")}</span>
          {system?.comfyuiVersion ? <span className="truncate text-[9px]" style={{ color: "var(--app-text-tertiary)" }}>v{system.comfyuiVersion}</span> : null}
        </div>
        <Button type="button" variant="ghost" size="icon-xs" disabled={loading || busy} onClick={() => void loadStats()} aria-label={t("comfyRefreshResources")} title={t("comfyRefreshResources")}>
          <RefreshCw className={loading ? "animate-spin" : ""} aria-hidden="true" />
        </Button>
      </div>
      {error ? <p className="text-[10px]" style={{ color: "var(--app-status-warning)" }}>{t("comfyResourcesUnavailable", { message: error })}</p> : null}
      {stats ? <>
        <div className="grid grid-cols-2 gap-1 text-[10px]" style={{ color: "var(--app-text-secondary)" }}>
          <span className="flex items-center gap-1"><Database className="size-3" aria-hidden="true" />{t("comfyRamFree")} {formatBytes(system?.ramFree)} / {formatBytes(system?.ramTotal)}</span>
          <span>{t("comfyRuntimeVersion", { version: system?.pytorchVersion || "-" })}</span>
        </div>
        {stats.devices.length > 0 ? <div className="space-y-1">
          {stats.devices.map((device, index) => <div key={`${device.name || "device"}-${device.index ?? index}`} className="flex min-w-0 items-center justify-between gap-2 rounded border border-[var(--app-border)] px-1.5 py-1 text-[10px]" style={{ color: "var(--app-text-secondary)" }}>
            <span className="min-w-0 truncate">{deviceLabel(device, index)}</span>
            <span className="shrink-0 tabular-nums">{formatBytes(device.vramFree)} / {formatBytes(device.vramTotal)}</span>
          </div>)}
        </div> : <p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyNoDevices")}</p>}
      </> : !loading && !error ? <p className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("comfyResourcesLoading")}</p> : null}
      <div className="flex flex-wrap gap-1">
        <Button type="button" variant="outline" size="xs" disabled={busy || loading || !stats} onClick={() => void releaseMemory(false)}><RefreshCw aria-hidden="true" />{t("comfyFreeMemory")}</Button>
        <Button type="button" variant="outline" size="xs" disabled={busy || loading || !stats} onClick={() => void releaseMemory(true)}><Trash2 aria-hidden="true" />{t("comfyUnloadModels")}</Button>
      </div>
    </section>
  );
}
