// 设置 → 设备与访问：本机 → 网络访问（Web 服务 / 登录认证 / 网络与远程）→ Tailscale →
// 已授权的客户端 + MCP → 编排器（MCP 端点）→ 服务控制。Web 服务状态在此持有，本机卡与服务控制共用。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SearchableSetting } from "./SettingsSearchContext";
import WebAccessOrchestratorBlock from "./WebAccessOrchestratorBlock";
import DeviceAccessPanel from "@/components/devices/DeviceAccessPanel";
import CcpanesMcpCard from "./CcpanesMcpCard";
import DeviceInfoSection from "./DeviceInfoSection";
import WebAccessServiceSection, { type WebAccessServiceAction } from "./WebAccessServiceSection";
import WebAccessTailscaleSection from "./WebAccessTailscaleSection";
import { toastErr, toastOk } from "@/lib/feedback";
import { RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { settingsService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import { useSettingsStore } from "@/stores";
import type { OrchestratorSettings, WebAccessSettings, WebAccessStatus } from "@/types";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./layout";

const TEXT_FIELD_CLASS = "h-8 w-44 bg-[var(--app-content)] text-[length:var(--text-row)]";
const NUMBER_FIELD_CLASS = "h-8 w-24 bg-[var(--app-content)] text-[length:var(--text-row)]";

interface WebAccessSectionProps {
  value: WebAccessSettings;
  onChange: (value: WebAccessSettings) => void;
  orchestrator?: OrchestratorSettings;
  onOrchestratorChange?: (value: OrchestratorSettings) => void;
}

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
      toastErr(t("webAccessSection.errors.statusReadFailed", { error: String(error) }));
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
      toastOk(t(password.trim() ? "webAccessSection.errors.passwordUpdated" : "webAccessSection.errors.passwordCleared"));
    } catch (error) {
      toastErr(t("webAccessSection.errors.passwordUpdateFailed", { error: String(error) }));
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleAction(action: WebAccessServiceAction) {
    try {
      if (action === "start") setStatus(await settingsService.startWebAccess());
      if (action === "stop") setStatus(await settingsService.stopWebAccess());
      if (action === "restart") setStatus(await settingsService.restartWebAccess());
      if (action === "open") await settingsService.openWebAccess();
    } catch (error) {
      toastErr(t("webAccessSection.errors.serviceActionFailed", { error: String(error) }));
    }
  }

  const mutedOrAccent = (ok: boolean, text: string) =>
    ok ? text : <span style={{ color: "var(--app-accent)" }}>{text}</span>;

  return (
    <>
      <DeviceInfoSection status={status} />

      <SearchableSetting sectionId="web-access-server">
        <SettingsSection title={t("webAccessGroups.server")}>
          <SettingsSwitchRow
            id="web-access-enabled"
            title={t("webAccessSection.startupEnabled")}
            description={t("webAccessSection.startupEnabledHint")}
            checked={value.enabled}
            onCheckedChange={(checked) => update("enabled", checked)}
          />
          <SettingsRow
            title={t("webAccessSection.port")}
            htmlFor="web-access-port"
            control={(
              <>
                <Input id="web-access-port" type="number" min={1} max={65535} value={value.port}
                  className={NUMBER_FIELD_CLASS} onChange={(event) => update("port", Number(event.target.value))} />
                <Button type="button" variant="secondary" size="sm" onClick={() => update("port", 18080)}>
                  <RotateCcw className="w-3.5 h-3.5 mr-1" />
                  {t("webAccessSection.reset")}
                </Button>
              </>
            )}
          />
          <SettingsSwitchRow
            id="web-access-auto-open"
            title={t("webAccessSection.autoOpen")}
            description={t("webAccessSection.autoOpenHint")}
            checked={value.autoOpen}
            onCheckedChange={(checked) => update("autoOpen", checked)}
          />
        </SettingsSection>
      </SearchableSetting>

      <SearchableSetting sectionId="web-access-auth">
        <SettingsSection title={t("webAccessGroups.auth")}>
          <SettingsSwitchRow
            id="web-access-auth-enabled"
            title={t("webAccessSection.authEnabled")}
            description={t("webAccessSection.authEnabledHint")}
            checked={value.authEnabled}
            onCheckedChange={(checked) => update("authEnabled", checked)}
          />
          <SettingsRow
            title={t("webAccessSection.username")}
            htmlFor="web-access-username"
            control={(
              <Input id="web-access-username" className={TEXT_FIELD_CLASS} value={value.username}
                onChange={(event) => update("username", event.target.value)} />
            )}
          />
          <SettingsRow
            title={t("webAccessSection.idleLock")}
            htmlFor="web-access-idle-lock"
            control={(
              <Input id="web-access-idle-lock" type="number" min={0} max={1440} value={value.lockOnIdleMinutes}
                className={NUMBER_FIELD_CLASS} onChange={(event) => update("lockOnIdleMinutes", Number(event.target.value))} />
            )}
          />
          <SettingsRow
            title={t(passwordConfigured ? "webAccessSection.updatePassword" : "webAccessSection.setPassword")}
            htmlFor="web-access-password"
            control={(
              <>
                <Input id="web-access-password" type="password" value={password} className={TEXT_FIELD_CLASS}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={t(passwordConfigured ? "webAccessSection.passwordPlaceholderConfigured" : "webAccessSection.passwordPlaceholder")} />
                <Button type="button" size="sm" onClick={handleSetPassword} disabled={savingPassword}>
                  <ShieldCheck className="w-3.5 h-3.5 mr-1" />
                  {t("webAccessSection.savePassword")}
                </Button>
              </>
            )}
          />
        </SettingsSection>
      </SearchableSetting>

      <SearchableSetting sectionId="web-access-network">
        <SettingsSection title={t("webAccessGroups.network")}>
          <SettingsSwitchRow
            id="web-access-allow-lan"
            title={t("webAccessSection.allowLan")}
            description={mutedOrAccent(
              canUseLan,
              t(canUseLan ? "webAccessSection.allowLanEnabledHint" : "webAccessSection.allowLanRequiresAuthHint"),
            )}
            checked={value.allowLan}
            disabled={!canUseLan}
            onCheckedChange={(checked) => update("allowLan", checked)}
          />
          <SettingsSwitchRow
            id="web-access-remote-read-only"
            title={t("webAccessSection.remoteReadOnly")}
            description={t("webAccessSection.remoteReadOnlyHint")}
            checked={value.remoteReadOnly}
            onCheckedChange={(checked) => update("remoteReadOnly", checked)}
          />
          {value.remoteReadOnly && (
            <SettingsSwitchRow
              id="web-access-remote-authenticated-write"
              title={t("webAccessSection.remoteAuthenticatedWrite")}
              description={mutedOrAccent(
                canUseLan,
                t(
                  canUseLan
                    ? "webAccessSection.remoteAuthenticatedWriteHint"
                    : "webAccessSection.remoteAuthenticatedWriteRequiresAuthHint",
                ),
              )}
              checked={value.remoteAuthenticatedWrite}
              disabled={!canUseLan}
              onCheckedChange={(checked) => update("remoteAuthenticatedWrite", checked)}
            />
          )}
          <SettingsRow
            title={t("webAccessSection.ipWhitelist")}
            description={t("webAccessSection.ipWhitelistHint")}
            htmlFor="web-access-ip-whitelist"
          >
            <textarea
              id="web-access-ip-whitelist"
              value={whitelistText}
              onChange={(event) => update("ipWhitelist", normalizeWhitelistText(event.target.value))}
              rows={3}
              className="px-2 py-1.5 rounded-md text-[length:var(--text-row)] outline-none font-mono resize-none"
              placeholder="192.168.1.20"
              style={{
                border: "1px solid var(--app-border)",
                background: "var(--app-content)",
                color: "var(--app-text-primary)",
              }}
            />
          </SettingsRow>
        </SettingsSection>
      </SearchableSetting>

      {isTauriRuntime() && <WebAccessTailscaleSection port={value.port} />}

      {isTauriRuntime() && (
        <DeviceAccessPanel
          allowDevices={Boolean(value.allowDevices)}
          onAllowDevicesChange={(allow) => update("allowDevices", allow)}
        />
      )}
      {isTauriRuntime() && <CcpanesMcpCard variant="section" />}

      <WebAccessOrchestratorBlock
        orchestrator={orchestrator}
        onOrchestratorChange={onOrchestratorChange}
      />

      <WebAccessServiceSection
        status={status}
        loadingStatus={loadingStatus}
        onRefresh={() => void refreshStatus()}
        onAction={handleAction}
      />
    </>
  );
}
