import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import packageJson from "../../../package.json";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { useInterruptGate } from "@/lib/interruptGate";
import {
  useDialogStore,
  useFullscreenStore,
  useMiniModeStore,
  useSettingsStore,
  useTerminalStatusStore,
  useUpdateStore,
} from "@/stores";
import {
  checkForAvailableUpdate,
  downloadAndInstallUpdate,
  getUpdateErrorHint,
  type UpdateInstallProgress,
} from "@/services/updaterService";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage, handleErrorSilent } from "@/utils";

const NOTIFICATION_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const RELEASES_URL = "https://github.com/wuxiran/cc-pane/releases/latest";

type CardView = "idle" | "confirm" | "installing" | "error";

export interface UpdateNotificationEligibility {
  available: boolean;
  version: string | null;
  notifyEnabled: boolean;
  skippedVersion: string | null;
  lastNotifiedAt: string | null;
  now: number;
}

export function shouldShowUpdateNotification({
  available,
  version,
  notifyEnabled,
  skippedVersion,
  lastNotifiedAt,
  now,
}: UpdateNotificationEligibility): boolean {
  if (!available || !version || !notifyEnabled || skippedVersion === version) return false;
  if (!lastNotifiedAt) return true;
  const lastNotified = Date.parse(lastNotifiedAt);
  return !Number.isFinite(lastNotified) || now - lastNotified >= NOTIFICATION_COOLDOWN_MS;
}

function selectHasOpenDialog(state: ReturnType<typeof useDialogStore.getState>): boolean {
  return (
    state.settingsOpen ||
    state.journalOpen ||
    state.localHistoryOpen ||
    state.gitTimelineOpen ||
    state.sessionCleanerOpen ||
    state.todoOpen ||
    state.plansOpen ||
    state.selfChatOpen ||
    state.aiPanelOpen ||
    state.onboardingOpen ||
    state.workspaceEnvironmentOpen ||
    state.launcherOpen
  );
}

export default function UpdateNotification() {
  const { t, i18n } = useTranslation("settings");
  const available = useUpdateStore((state) => state.available);
  const version = useUpdateStore((state) => state.version);
  const body = useUpdateStore((state) => state.body);
  const updateSettings = useSettingsStore((state) => state.settings?.update ?? null);
  const statusMap = useTerminalStatusStore((state) => state.statusMap);
  const hasOpenDialog = useDialogStore(selectHasOpenDialog);
  const isMiniMode = useMiniModeStore((state) => state.isMiniMode);
  const isFullscreen = useFullscreenStore((state) => state.isFullscreen);
  const { activeInterrupt, check, occupy, release } = useInterruptGate("update");
  const [clock, setClock] = useState(Date.now);
  const [visible, setVisible] = useState(false);
  const [currentVersion, setCurrentVersion] = useState(packageJson.version);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<CardView>("idle");
  const [busyAtConfirmation, setBusyAtConfirmation] = useState(false);
  const [progress, setProgress] = useState<UpdateInstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suppressedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    getVersion().then(setCurrentVersion).catch((reason) => {
      handleErrorSilent(reason, "get app version for update notification");
    });
  }, []);

  const persistUpdateSettings = useCallback(async (patch: Partial<NonNullable<typeof updateSettings>>) => {
    const store = useSettingsStore.getState();
    if (!store.settings) return;
    await store.saveSettings({
      ...store.settings,
      update: { ...store.settings.update, ...patch },
    });
  }, []);

  useEffect(() => {
    if (visible || !updateSettings || suppressedVersionRef.current === version) return;
    if (!shouldShowUpdateNotification({
      available,
      version,
      notifyEnabled: updateSettings.notifyEnabled,
      skippedVersion: updateSettings.skippedVersion,
      lastNotifiedAt: updateSettings.lastNotifiedAt,
      now: clock,
    })) return;
    if (check() !== null) return;

    occupy();
    setVisible(true);
    void persistUpdateSettings({ lastNotifiedAt: new Date(clock).toISOString() }).catch((reason) => {
      handleErrorSilent(reason, "persist update notification timestamp");
    });
  }, [
    activeInterrupt,
    available,
    check,
    clock,
    hasOpenDialog,
    isFullscreen,
    isMiniMode,
    occupy,
    persistUpdateSettings,
    statusMap,
    updateSettings,
    version,
    visible,
  ]);

  useEffect(() => () => release(), [release]);

  const releaseCard = useCallback(() => {
    suppressedVersionRef.current = version;
    setVisible(false);
    setView("idle");
    setExpanded(false);
    setProgress(null);
    setError(null);
    release();
  }, [release, version]);

  useEffect(() => {
    if (!visible) return;
    if (!available || !version || updateSettings?.notifyEnabled === false || updateSettings?.skippedVersion === version) {
      releaseCard();
    }
  }, [available, releaseCard, updateSettings, version, visible]);

  const handleLater = useCallback(() => {
    void persistUpdateSettings({ lastNotifiedAt: new Date().toISOString() }).catch((reason) => {
      handleErrorSilent(reason, "persist update notification cooldown");
    });
    releaseCard();
  }, [persistUpdateSettings, releaseCard]);

  const handleSkip = useCallback(() => {
    if (version) {
      void persistUpdateSettings({
        skippedVersion: version,
        lastNotifiedAt: new Date().toISOString(),
      }).catch((reason) => handleErrorSilent(reason, "persist skipped update version"));
    }
    releaseCard();
  }, [persistUpdateSettings, releaseCard, version]);

  const requestInstall = useCallback(() => {
    setBusyAtConfirmation(check({ ignoreOwnInterrupt: true }) === "agentBusy");
    setView("confirm");
  }, [check]);

  const install = useCallback(async () => {
    const latestGateReason = check({ ignoreOwnInterrupt: true });
    if (latestGateReason === "agentBusy" && !busyAtConfirmation) {
      setBusyAtConfirmation(true);
      return;
    }

    setView("installing");
    setProgress(null);
    setError(null);
    try {
      const update = await checkForAvailableUpdate();
      if (!update) {
        useUpdateStore.getState().clearUpdate();
        releaseCard();
        return;
      }
      await downloadAndInstallUpdate(update, setProgress);
    } catch (reason) {
      const message = getErrorMessage(reason);
      const hint = getUpdateErrorHint(message, i18n.language).trim();
      setError(hint ? `${message}\n\n${hint}` : message);
      setView("error");
    }
  }, [busyAtConfirmation, check, i18n.language, releaseCard]);

  const openDownloadPage = useCallback(async () => {
    try {
      if (isTauriRuntime()) {
        await openUrl(RELEASES_URL);
      } else {
        window.open(RELEASES_URL, "_blank", "noopener,noreferrer");
      }
    } catch (reason) {
      handleErrorSilent(reason, "open update download page");
    }
  }, []);

  const releaseNotes = useMemo(() => body?.trim() || t("updateBodyFallback"), [body, t]);
  if (!visible || !version) return null;

  const normalizedCurrentVersion = currentVersion.replace(/^v/i, "");
  const normalizedNextVersion = version.replace(/^v/i, "");
  const progressLabel = progress?.phase === "installing"
    ? t("updateInstalling")
    : progress
      ? t("updateDownloading")
      : t("updateCheckingLatest");

  return (
    <aside
      aria-live="polite"
      aria-label={t("updateCardTitle", { version: normalizedNextVersion })}
      className="fixed bottom-11 right-3 z-40 w-[min(380px,calc(100vw-24px))] overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-bg)] shadow-lg motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in"
    >
      <div className="flex items-start gap-3 px-4 pt-4">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--app-active-bg)] text-[var(--app-accent)]">
          {view === "error" ? <AlertTriangle size={17} /> : <ArrowUpCircle size={17} />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-[var(--app-text-primary)]">
            {view === "error"
              ? t("updateFailed")
              : t("updateCardTitle", { version: normalizedNextVersion })}
          </h2>
          <p className="mt-0.5 text-[11px] text-[var(--app-text-tertiary)]">
            {t("updateVersionTransition", {
              current: normalizedCurrentVersion,
              next: normalizedNextVersion,
            })}
          </p>
        </div>
        {view === "idle" && (
          <IconTooltipButton label={t("updateClose")} side="left" onClick={handleLater}>
            <X aria-hidden="true" size={15} />
          </IconTooltipButton>
        )}
      </div>

      <div className="px-4 pb-4 pt-3">
        {view === "idle" && (
          <>
            <p
              className={expanded
                ? "max-h-44 overflow-y-auto whitespace-pre-wrap text-[12px] leading-5 text-[var(--app-text-secondary)]"
                : "line-clamp-4 whitespace-pre-wrap text-[12px] leading-5 text-[var(--app-text-secondary)]"}
            >
              {releaseNotes}
            </p>
            {body?.trim() && (
              <button
                type="button"
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[var(--app-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {expanded ? t("updateHideDetails") : t("updateViewDetails")}
              </button>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={requestInstall}>
                <Download aria-hidden="true" size={14} />
                {t("updateNow")}
              </Button>
              <Button size="sm" variant="secondary" onClick={handleLater}>{t("updateLater")}</Button>
              <Button size="sm" variant="ghost" onClick={handleSkip}>{t("updateSkipVersion")}</Button>
            </div>
          </>
        )}

        {view === "confirm" && (
          <div className="space-y-3">
            <div className="flex gap-2 py-1">
              <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--app-status-warning)]" size={16} />
              <div>
                <p className="text-[13px] font-medium text-[var(--app-text-primary)]">{t("updateRestartTitle")}</p>
                <p className="mt-1 text-[12px] leading-5 text-[var(--app-text-secondary)]">{t("updateRestartWarning")}</p>
                {busyAtConfirmation && (
                  <p className="mt-1 text-[12px] leading-5 text-[var(--app-status-warning)]">{t("updateRestartBusyWarning")}</p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setView("idle")}>{t("updateCancel")}</Button>
              <Button size="sm" onClick={() => void install()}>{t("updateConfirm")}</Button>
            </div>
          </div>
        )}

        {view === "installing" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[12px] text-[var(--app-text-secondary)]">
              {progress?.phase === "installing"
                ? <CheckCircle2 aria-hidden="true" size={16} className="text-[var(--app-status-success)]" />
                : <LoaderCircle aria-hidden="true" size={16} className="text-[var(--app-accent)] motion-safe:animate-spin" />}
              <span>{progressLabel}</span>
              {progress?.percent !== null && progress?.percent !== undefined && (
                <span className="ml-auto tabular-nums">{progress.percent}%</span>
              )}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--app-hover)]">
              <div
                className="h-full rounded-full bg-[var(--app-accent)] transition-[width] duration-[var(--dur-normal)] motion-reduce:transition-none"
                style={{ width: `${progress?.percent ?? 12}%` }}
              />
            </div>
          </div>
        )}

        {view === "error" && (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-[12px] leading-5 text-[var(--app-text-secondary)]">{error}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={requestInstall}>
                <RotateCcw aria-hidden="true" size={14} />
                {t("updateRetry")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void openDownloadPage()}>
                <ExternalLink aria-hidden="true" size={14} />
                {t("updateDownloadPage")}
              </Button>
              <Button size="sm" variant="ghost" onClick={handleLater}>{t("updateLater")}</Button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
