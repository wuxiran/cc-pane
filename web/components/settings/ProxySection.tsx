import { toast } from "sonner";
import { useTranslation } from "react-i18next";
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

  function update<K extends keyof ProxySettings>(key: K, v: ProxySettings[K]) {
    onChange({ ...value, [key]: v });
  }

  async function testProxy() {
    try {
      await settingsService.testProxy();
      toast.success(t("proxyTestSuccess"));
    } catch (e) {
      toast.error(t("proxyTestFailed", { error: e }));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("proxyTitle")}
      </h3>

      <div className="flex items-center justify-between">
        <Label>{t("enableProxy")}</Label>
        <input
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
              <Label>{t("proxyType")}</Label>
              <Select value={value.proxyType} onValueChange={(next) => update("proxyType", next)}>
                <SelectTrigger aria-label={t("proxyType")} className="w-44 shrink-0 bg-[var(--app-content)] text-[13px]">
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
            <div className="flex flex-col gap-1 flex-1">
              <Label>{t("host")}</Label>
              <Input value={value.host} placeholder="127.0.0.1" onChange={(e) => update("host", e.target.value)} />
            </div>
            <div className="flex flex-col gap-1 w-28">
              <Label>{t("port")}</Label>
              <Input type="number" value={value.port} placeholder="7890" onChange={(e) => update("port", Number(e.target.value))} />
            </div>
          </div>

          <div className="flex gap-2">
            <div className="flex flex-col gap-1 flex-1">
              <Label>{t("username")}</Label>
              <Input
                value={value.username ?? ""}
                placeholder={t("username")}
                onChange={(e) => update("username", e.target.value || null)}
              />
            </div>
            <div className="flex flex-col gap-1 flex-1">
              <Label>{t("password")}</Label>
              <Input
                type="password"
                value={value.password ?? ""}
                placeholder={t("password")}
                onChange={(e) => update("password", e.target.value || null)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label>{t("excludeList")}</Label>
            <Input
              value={value.noProxy ?? ""}
              placeholder="localhost,127.0.0.1"
              onChange={(e) => update("noProxy", e.target.value || null)}
            />
            <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("excludeListHint")}
            </span>
          </div>

          <div>
            <Button size="sm" variant="secondary" onClick={testProxy}>{t("testConnection")}</Button>
          </div>
        </>
      )}
    </div>
  );
}
