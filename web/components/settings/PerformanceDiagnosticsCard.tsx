import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { performanceService } from "@/services/performanceService";
import { isTauriRuntime } from "@/services/runtime";

export default function PerformanceDiagnosticsCard() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<Awaited<ReturnType<typeof performanceService.getStatus>>>();
  const [error, setError] = useState<string | null>(null);
  const [marked, setMarked] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (isTauriRuntime()) performanceService.getStatus().then(
      value => { if (!cancelled) setStatus(value); },
      reason => { if (!cancelled) setError(String(reason)); },
    );
    return () => { cancelled = true; };
  }, []);
  const act = async (mark: boolean) => {
    setBusy(true); setError(null);
    try {
      if (mark) { await performanceService.markIncident(); setMarked(true); }
      else await performanceService.openDirectory();
      setStatus(await performanceService.getStatus());
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  if (!isTauriRuntime()) return null;
  return <div className="border-t pt-3 space-y-2 text-[12px]">
    <div className="font-medium">{t("performanceRecords")}</div>
    <p style={{ color: "var(--app-text-secondary)" }}>{t("performanceRecordsDescription")}</p>
    <p role="status">{status?.running && !status.lastError ? t("performanceRecording") : t("performanceRecorderUnavailable")}</p>
    <div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(false)}>{t("openPerformanceRecords")}</Button>
      <Button variant="outline" size="sm" disabled={busy || !status?.running || Boolean(status.lastError)} onClick={() => void act(true)}>{t("markPerformanceIncident")}</Button>
    </div>
    {marked && <p role="status">{t("performanceIncidentMarked")}</p>}
    {(error || status?.lastError) && <p role="alert">{error ?? status?.lastError}</p>}
  </div>;
}
