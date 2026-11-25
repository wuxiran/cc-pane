import { useId } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settingsService } from "@/services";
import type { ProxySettings } from "@/types";
import { SearchableSetting } from "./SettingsSearchContext";
import { SettingsBlock, SettingsRow, SettingsSection, SettingsSwitchRow } from "./layout";

interface ProxySectionProps {
  value: ProxySettings;
  onChange: (value: ProxySettings) => void;
}

const FIELD_CLASS = "h-8 w-44 bg-[var(--app-content)] text-[length:var(--text-row)]";

export default function ProxySection({ value, onChange }: ProxySectionProps) {
  const { t } = useTranslation("settings");
  const enabledId = useId();
  const proxyTypeId = useId();
  const hostId = useId();
  const portId = useId();
  const usernameId = useId();
  const passwordId = useId();
  const noProxyId = useId();

  function update<K extends keyof ProxySettings>(key: K, v: ProxySettings[K]) {
    onChange({ ...value, [key]: v });
  }

  async function testProxy() {
    try {
      await settingsService.testProxy();
      toastOk(t("proxyTestSuccess"));
    } catch (e) {
      toastErr(t("proxyTestFailed", { error: e }));
    }
  }

  return (
    <>
      <SettingsSection>
        <SettingsSwitchRow
          id={enabledId}
          title={t("enableProxy")}
          checked={value.enabled}
          onCheckedChange={(checked) => update("enabled", checked)}
        />
      </SettingsSection>

      {value.enabled && (
        <SearchableSetting sectionId="proxy-server">
          <SettingsSection title={t("proxyGroups.server")}>
            <SettingsRow
              title={t("proxyType")}
              htmlFor={proxyTypeId}
              control={(
                <Select value={value.proxyType} onValueChange={(next) => update("proxyType", next)}>
                  <SelectTrigger id={proxyTypeId} aria-label={t("proxyType")} className="w-44 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="socks5">SOCKS5</SelectItem>
                  </SelectContent>
                </Select>
              )}
            >
              {value.proxyType === "socks5" && (
                <div
                  className="px-2.5 py-2 text-[length:var(--text-small)] leading-relaxed rounded-md"
                  style={{
                    color: "var(--app-status-warning)",
                    background: "var(--app-status-warning-bg)",
                    border: "1px solid var(--app-status-warning-border)",
                  }}
                >
                  &#9888; {t("socksWarning")}
                </div>
              )}
            </SettingsRow>
            <SettingsRow
              title={t("host")}
              htmlFor={hostId}
              control={(
                <Input id={hostId} className={FIELD_CLASS} value={value.host} placeholder="127.0.0.1" onChange={(e) => update("host", e.target.value)} />
              )}
            />
            <SettingsRow
              title={t("port")}
              htmlFor={portId}
              control={(
                <Input id={portId} className="h-8 w-28 bg-[var(--app-content)] text-[length:var(--text-row)]" type="number" value={value.port} placeholder="7890" onChange={(e) => update("port", Number(e.target.value))} />
              )}
            />
            <SettingsRow
              title={t("username")}
              htmlFor={usernameId}
              control={(
                <Input
                  id={usernameId}
                  className={FIELD_CLASS}
                  value={value.username ?? ""}
                  placeholder={t("username")}
                  onChange={(e) => update("username", e.target.value || null)}
                />
              )}
            />
            <SettingsRow
              title={t("password")}
              htmlFor={passwordId}
              control={(
                <Input
                  id={passwordId}
                  className={FIELD_CLASS}
                  type="password"
                  value={value.password ?? ""}
                  placeholder={t("password")}
                  onChange={(e) => update("password", e.target.value || null)}
                />
              )}
            />
            <SettingsRow
              title={t("excludeList")}
              description={t("excludeListHint")}
              htmlFor={noProxyId}
              control={(
                <Input
                  id={noProxyId}
                  className={FIELD_CLASS}
                  value={value.noProxy ?? ""}
                  placeholder="localhost,127.0.0.1"
                  onChange={(e) => update("noProxy", e.target.value || null)}
                />
              )}
            />
            <SettingsBlock className="flex justify-end py-3">
              <Button size="sm" variant="secondary" onClick={testProxy}>{t("testConnection")}</Button>
            </SettingsBlock>
          </SettingsSection>
        </SearchableSetting>
      )}
    </>
  );
}
