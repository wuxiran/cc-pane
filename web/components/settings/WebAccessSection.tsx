import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import McpYoloProfilesToggle from "./McpYoloProfilesToggle";
import FollowAgentLaunchToggle from "./FollowAgentLaunchToggle";
import { toast } from "sonner";
import { ExternalLink, RefreshCw, RotateCcw, ShieldCheck, Square, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settingsService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { useSettingsStore } from "@/stores";
import { useOrchestratorStatus } from "@/hooks/useOrchestratorStatus";
import type { OrchestratorBindMode, OrchestratorSettings, TailscaleStatus, WebAccessSettings, WebAccessStatus } from "@/types";

interface WebAccessSectionProps {
  value: WebAccessSettings;
  onChange: (value: WebAccessSettings) => void;
  orchestrator?: OrchestratorSettings;
  onOrchestratorChange?: (value: OrchestratorSettings) => void;
}

const ORCHESTRATOR_BIND_MODES: OrchestratorBindMode[] = ["auto", "loopback", "all"];
// 旧配置可能残留已下线的 bindMode；直接拿它拼 i18n key 会把 key 原样渲染给用户。
const normalizeBindMode = (mode?: string) => ORCHESTRATOR_BIND_MODES.find((m) => m === mode) ?? "auto";

function normalizeWhitelistText(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function WebAccessSection({
  value,
  onChange,
  orchestrator,
  onOrchestratorChange,
}: WebAccessSectionProps) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<WebAccessStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const orchestratorStatus = useOrchestratorStatus();
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null);
  const [detectingTailscale, setDetectingTailscale] = useState(false);
  const [password, setPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const currentSettings = useSettingsStore((state) => state.settings);
  const passwordConfigured = Boolean(value.passwordHash || currentSettings?.webAccess.passwordHash);
  const canUseLan = value.authEnabled && passwordConfigured;

  const whitelistText = useMemo(() => value.ipWhitelist.join("\n"), [value.ipWhitelist]);

  function update<K extends keyof WebAccessSettings>(key: K, next: WebAccessSettings[K]) {
    onChange({ ...value, [key]: next });
  }

  async function refreshStatus() {
    setLoadingStatus(true);
    try {
      setStatus(await settingsService.getWebAccessStatus());
    } catch (error) {
      toast.error(t("webAccessSection.errors.statusReadFailed", { error: String(error) }));
    } finally {
      setLoadingStatus(false);
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function handleSetPassword() {
    setSavingPassword(true);
    try {
      await settingsService.setWebAccessPassword(password);
      setPassword("");
      await loadSettings();
      await refreshStatus();
      toast.success(t(password.trim() ? "webAccessSection.errors.passwordUpdated" : "webAccessSection.errors.passwordCleared"));
    } catch (error) {
      toast.error(t("webAccessSection.errors.passwordUpdateFailed", { error: String(error) }));
    } finally {
      setSavingPassword(false);
    }
  }

  async function detectTailscale() {
    setDetectingTailscale(true);
    try {
      setTailscale(await settingsService.detectTailscaleStatus());
    } catch (error) {
      toast.error(t("webAccessSection.errors.tailscaleDetectionFailed", { error: String(error) }));
    } finally {
      setDetectingTailscale(false);
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("webAccessSection.errors.copied", { label }));
    } catch (error) {
      toast.error(t("webAccessSection.errors.copyFailed", { error: String(error) }));
    }
  }

  async function handleAction(action: "start" | "stop" | "restart" | "open") {
    try {
      if (action === "start") setStatus(await settingsService.startWebAccess());
      if (action === "stop") setStatus(await settingsService.stopWebAccess());
      if (action === "restart") setStatus(await settingsService.restartWebAccess());
      if (action === "open") await settingsService.openWebAccess();
    } catch (error) {
      toast.error(t("webAccessSection.errors.serviceActionFailed", { error: String(error) }));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <Label>{t("webAccessSection.startupEnabled")}</Label>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t("webAccessSection.startupEnabledHint")}
          </p>
        </div>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => update("enabled", event.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
        <div className="flex flex-col gap-1">
          <Label>{t("webAccessSection.port")}</Label>
          <Input
            type="number"
            min={1}
            max={65535}
            value={value.port}
            onChange={(event) => update("port", Number(event.target.value))}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => update("port", 18080)}
        >
          <RotateCcw className="w-3.5 h-3.5 mr-1" />
          {t("webAccessSection.reset")}
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <Label>{t("webAccessSection.autoOpen")}</Label>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t("webAccessSection.autoOpenHint")}
          </p>
        </div>
        <input
          type="checkbox"
          checked={value.autoOpen}
          onChange={(event) => update("autoOpen", event.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      <div className="flex flex-col gap-3 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <div className="flex items-center justify-between">
          <div>
            <Label>{t("webAccessSection.authEnabled")}</Label>
            <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
              {t("webAccessSection.authEnabledHint")}
            </p>
          </div>
          <input
            type="checkbox"
            checked={value.authEnabled}
            onChange={(event) => update("authEnabled", event.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label>{t("webAccessSection.username")}</Label>
            <Input value={value.username} onChange={(event) => update("username", event.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t("webAccessSection.idleLock")}</Label>
            <Input
              type="number"
              min={0}
              max={1440}
              value={value.lockOnIdleMinutes}
              onChange={(event) => update("lockOnIdleMinutes", Number(event.target.value))}
            />
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
          <div className="flex flex-col gap-1">
            <Label>{t(passwordConfigured ? "webAccessSection.updatePassword" : "webAccessSection.setPassword")}</Label>
            <Input
              type="password"
              value={password}
              placeholder={t(passwordConfigured ? "webAccessSection.passwordPlaceholderConfigured" : "webAccessSection.passwordPlaceholder")}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <Button type="button" size="sm" onClick={handleSetPassword} disabled={savingPassword}>
            <ShieldCheck className="w-3.5 h-3.5 mr-1" />
            {t("webAccessSection.savePassword")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <div className="flex items-center justify-between">
          <div>
            <Label>{t("webAccessSection.allowLan")}</Label>
            <p className="text-xs m-0" style={{ color: canUseLan ? "var(--app-text-tertiary)" : "var(--app-accent)" }}>
              {t(canUseLan ? "webAccessSection.allowLanEnabledHint" : "webAccessSection.allowLanRequiresAuthHint")}
            </p>
          </div>
          <input
            type="checkbox"
            checked={value.allowLan}
            disabled={!canUseLan}
            onChange={(event) => update("allowLan", event.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>{t("webAccessSection.remoteReadOnly")}</Label>
            <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
              {t("webAccessSection.remoteReadOnlyHint")}
            </p>
          </div>
          <input
            type="checkbox"
            checked={value.remoteReadOnly}
            onChange={(event) => update("remoteReadOnly", event.target.checked)}
            className="w-4 h-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
        </div>

        {value.remoteReadOnly && (
          <div className="flex items-center justify-between pl-4">
            <div>
              <Label>{t("webAccessSection.remoteAuthenticatedWrite")}</Label>
              <p className="text-xs m-0" style={{ color: canUseLan ? "var(--app-text-tertiary)" : "var(--app-accent)" }}>
                {t(
                  canUseLan
                    ? "webAccessSection.remoteAuthenticatedWriteHint"
                    : "webAccessSection.remoteAuthenticatedWriteRequiresAuthHint",
                )}
              </p>
            </div>
            <input
              type="checkbox"
              checked={value.remoteAuthenticatedWrite}
              disabled={!canUseLan}
              onChange={(event) => update("remoteAuthenticatedWrite", event.target.checked)}
              className="w-4 h-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <Label>{t("webAccessSection.ipWhitelist")}</Label>
          <textarea
            value={whitelistText}
            onChange={(event) => update("ipWhitelist", normalizeWhitelistText(event.target.value))}
            rows={3}
            className="px-2 py-1.5 rounded-md text-[13px] outline-none font-mono resize-none"
            placeholder="192.168.1.20"
            style={{
              border: "1px solid var(--app-border)",
              background: "var(--app-content)",
              color: "var(--app-text-primary)",
            }}
          />
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t("webAccessSection.ipWhitelistHint")}
          </p>
        </div>
      </div>

      {orchestrator && onOrchestratorChange && isTauriRuntime() && (
        <div className="flex flex-col gap-2 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
          <div>
            <Label>{t("webAccessSection.orchestrator.title")}</Label>
            <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
              {t("webAccessSection.orchestrator.description")}
            </p>
          </div>
          <div className="flex items-center justify-between gap-6">
            <span className="text-[13px] text-[var(--app-text-secondary)]">
              {t("webAccessSection.orchestrator.bindMode")}
            </span>
            <Select
              value={normalizeBindMode(orchestrator.bindMode)}
              onValueChange={(next) =>
                onOrchestratorChange({ ...orchestrator, bindMode: next as OrchestratorBindMode })
              }
            >
              <SelectTrigger aria-label={t("webAccessSection.orchestrator.bindMode")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORCHESTRATOR_BIND_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`webAccessSection.orchestrator.bindModes.${mode}.label`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t(`webAccessSection.orchestrator.bindModes.${normalizeBindMode(orchestrator.bindMode)}.hint`)}
          </p>
          <McpYoloProfilesToggle orchestrator={orchestrator} onChange={onOrchestratorChange} />
          <FollowAgentLaunchToggle orchestrator={orchestrator} onChange={onOrchestratorChange} />
          {orchestratorStatus?.bind && (
            <p className="text-xs m-0" style={{ color: "var(--app-text-secondary)" }}>
              {t("webAccessSection.orchestrator.currentListen", {
                address: `${orchestratorStatus.bind.host}${
                  orchestratorStatus.port != null ? `:${orchestratorStatus.port}` : ""
                }`,
                reason: orchestratorStatus.bind.reason,
              })}
            </p>
          )}
          {orchestratorStatus && (
            <p className="text-xs m-0" style={{ color: "var(--app-text-secondary)" }}>
              {t("orchestratorStatus.summary", {
                lifecycle:
                  orchestratorStatus.lifecycle === "binding"
                    ? t("orchestratorStatus.binding")
                    : orchestratorStatus.lifecycle === "ready"
                      ? t("orchestratorStatus.ready")
                      : t("orchestratorStatus.failed"),
              })}
              {orchestratorStatus.attempt != null
                ? ` · ${t("orchestratorStatus.attempt", { attempt: orchestratorStatus.attempt })}`
                : ""}
              {orchestratorStatus.nextRetryAt != null
                ? ` · ${t("orchestratorStatus.nextRetry", {
                    time: new Date(orchestratorStatus.nextRetryAt).toLocaleTimeString(),
                  })}`
                : ""}
            </p>
          )}
          {orchestratorStatus?.lastError && (
            <p
              className="text-xs m-0 whitespace-pre-wrap break-words"
              style={{ color: "var(--app-status-danger)" }}
            >
              {t("orchestratorStatus.lastError", { error: orchestratorStatus.lastError })}
            </p>
          )}
        </div>
      )}

      {isTauriRuntime() && (
        <div className="flex flex-col gap-2 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
          <div className="flex items-center justify-between">
            <div>
              <Label>{t("webAccessSection.tailscale.title")}</Label>
              <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
                {t("webAccessSection.tailscale.description")}
              </p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => void detectTailscale()} disabled={detectingTailscale}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${detectingTailscale ? "animate-spin" : ""}`} />
              {t("webAccessSection.tailscale.detect")}
            </Button>
          </div>
          {tailscale && !tailscale.installed && (
            <p className="text-xs m-0" style={{ color: "var(--app-text-secondary)" }}>
              {t("webAccessSection.tailscale.cliNotFound")}
            </p>
          )}
          {tailscale?.installed && tailscale.backendState !== "Running" && (
            <p className="text-xs m-0" style={{ color: "var(--app-text-secondary)" }}>
              {t("webAccessSection.tailscale.notRunning", {
                state: tailscale.backendState
                  ? t("webAccessSection.tailscale.stateSuffix", { state: tailscale.backendState })
                  : "",
              })} <code>tailscale up</code> {t("webAccessSection.tailscale.login")}
            </p>
          )}
          {tailscale?.installed && tailscale.backendState === "Running" && (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
                <code
                  className="px-2 py-1.5 rounded-md text-[12px] font-mono overflow-x-auto whitespace-nowrap"
                  style={{ border: "1px solid var(--app-border)", background: "var(--app-content)", color: "var(--app-text-primary)" }}
                >
                  {`tailscale serve --bg --https=443 http://127.0.0.1:${value.port}`}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    void copyText(
                      `tailscale serve --bg --https=443 http://127.0.0.1:${value.port}`,
                      t("webAccessSection.tailscale.command"),
                    )
                  }
                >
                  {t("webAccessSection.tailscale.copyCommand")}
                </Button>
              </div>
              {tailscale.dnsName && (
                <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
                  <code
                    className="px-2 py-1.5 rounded-md text-[12px] font-mono overflow-x-auto whitespace-nowrap"
                    style={{ border: "1px solid var(--app-border)", background: "var(--app-content)", color: "var(--app-text-primary)" }}
                  >
                    {`https://${tailscale.dnsName}`}
                  </code>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void copyText(`https://${tailscale.dnsName}`, t("webAccessSection.tailscale.address"))
                    }
                  >
                    {t("webAccessSection.tailscale.copyAddress")}
                  </Button>
                </div>
              )}
              <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
                {t("webAccessSection.tailscale.tailnetHint")} <code>tailscale serve reset</code>
                {t("webAccessSection.tailscale.tailnetHintEnd")}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 pt-3" style={{ borderTop: "1px solid var(--app-border)" }}>
        <div className="flex items-center justify-between">
          <div className="text-xs" style={{ color: "var(--app-text-secondary)" }}>
            {status
              ? `${t(status.running ? "webAccessSection.status.running" : "webAccessSection.status.stopped")} · ${status.url} · ${status.bindHost}:${status.port}`
              : t("webAccessSection.status.unread")}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={refreshStatus} disabled={loadingStatus}>
            <RefreshCw className={`w-3.5 h-3.5 ${loadingStatus ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void handleAction("open")}>
            <ExternalLink className="w-3.5 h-3.5 mr-1" />
            {t("webAccessSection.openWeb")}
          </Button>
          {isTauriRuntime() && (
            <>
              <Button type="button" variant="secondary" size="sm" onClick={() => void handleAction("start")}>
                <Wifi className="w-3.5 h-3.5 mr-1" />
                {t("webAccessSection.start")}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => void handleAction("restart")}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                {t("webAccessSection.restart")}
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => void handleAction("stop")}>
                <Square className="w-3.5 h-3.5 mr-1" />
                {t("webAccessSection.stop")}
              </Button>
            </>
          )}
        </div>
        <p className="text-xs m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("webAccessSection.restartHint")}
        </p>
      </div>
    </div>
  );
}
