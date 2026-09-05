import { useId } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settingsService } from "@/services";
import type { ProxySettings } from "@/types";

interface ProxySectionProps {
  value: ProxySettings;
  onChange: (value: ProxySettings) => void;
}

export default function ProxySection({ value, onChange }: ProxySectionProps) {
  const { t } = useTranslation("settings");
  const enabledId = useId();
  const proxyTypeId = useId();

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
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("proxyTitle")}
      </h3>

      <div className="flex items-center justify-between">
        <Label htmlFor={enabledId}>{t("enableProxy")}</Label>
        <input
          id={enabledId}
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => update("enabled", e.target.checked)}
          className="w-4 h-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
      </div>

      {value.enabled && (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-6">
              <Label htmlFor={proxyTypeId}>{t("proxyType")}</Label>
              <Select value={value.proxyType} onValueChange={(next) => update("proxyType", next)}>
                <SelectTrigger id={proxyTypeId} aria-label={t("proxyType")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="socks5">SOCKS5</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {value.proxyType === "socks5" && (
              <div
                className="mt-1 px-2.5 py-2 text-xs leading-relaxed rounded-md"
                style={{
                  color: "var(--app-status-warning)",
                  background: "var(--app-status-warning-bg)",
                  border: "1px solid var(--app-status-warning-border)",
                }}
              >
                &#9888; {t("socksWarning")}
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <FormField label={t("host")} className="flex flex-col gap-1 flex-1">
              {({ id }) => (
                <Input id={id} value={value.host} placeholder="127.0.0.1" onChange={(e) => update("host", e.target.value)} />
              )}
            </FormField>
            <FormField label={t("port")} className="flex flex-col gap-1 w-28">
              {({ id }) => (
                <Input id={id} type="number" value={value.port} placeholder="7890" onChange={(e) => update("port", Number(e.target.value))} />
              )}
            </FormField>
          </div>

          <div className="flex gap-2">
            <FormField label={t("username")} className="flex flex-col gap-1 flex-1">
              {({ id }) => (
                <Input
                  id={id}
                  value={value.username ?? ""}
                  placeholder={t("username")}
                  onChange={(e) => update("username", e.target.value || null)}
                />
              )}
            </FormField>
            <FormField label={t("password")} className="flex flex-col gap-1 flex-1">
              {({ id }) => (
                <Input
                  id={id}
                  type="password"
                  value={value.password ?? ""}
                  placeholder={t("password")}
                  onChange={(e) => update("password", e.target.value || null)}
                />
              )}
            </FormField>
          </div>

          <FormField
            label={t("excludeList")}
            hint={t("excludeListHint")}
            className="flex flex-col gap-1"
            hintClassName="text-[11px] text-[var(--app-text-tertiary)]"
          >
            {({ id, hintId }) => (
              <Input
                id={id}
                aria-describedby={hintId}
                value={value.noProxy ?? ""}
                placeholder="localhost,127.0.0.1"
                onChange={(e) => update("noProxy", e.target.value || null)}
              />
            )}
          </FormField>

          <div>
            <Button size="sm" variant="secondary" onClick={testProxy}>{t("testConnection")}</Button>
          </div>
        </>
      )}
    </div>
  );
}
