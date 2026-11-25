import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { performanceService } from "@/services/performanceService";
import { isTauriRuntime } from "@/services/runtime";
import { SettingsHint, SettingsRow, SettingsSection } from "./layout";

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
  const recording = Boolean(status?.running && !status.lastError);
  const failure = error ?? status?.lastError;
  return (
    <SettingsSection title={t("performanceRecords")} description={t("performanceRecordsDescription")}>
      <SettingsRow
        title={<span role="status">{recording ? t("performanceRecording") : t("performanceRecorderUnavailable")}</span>}
        control={(
          <>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(false)}>{t("openPerformanceRecords")}</Button>
            <Button variant="outline" size="sm" disabled={busy || !status?.running || Boolean(status.lastError)} onClick={() => void act(true)}>{t("markPerformanceIncident")}</Button>
          </>
        )}
      >
        {marked && <SettingsHint><span role="status">{t("performanceIncidentMarked")}</span></SettingsHint>}
        {failure && (
          <p role="alert" className="m-0 break-all text-[length:var(--text-small)] text-[var(--app-status-danger)]">{failure}</p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
