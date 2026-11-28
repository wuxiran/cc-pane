// 供应商表单里的「提醒」：缓存命中率偏低、上次检测发现提示词注入。默认全开，只读本地数据，不发请求。
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ProviderType } from "@/types/provider";
import type { ProviderAlerts } from "@/types/providerAlerts";

/** Claude（Anthropic 接口）和 Codex（OpenAI 接口）的会话才有用量和检测数据。 */
export function providerTypeHasAlerts(type: ProviderType): boolean {
  return type === "anthropic" || type === "proxy" || type === "open_ai";
}

const ROWS = [
  { id: "cacheLow", label: "alerts.cacheLow", desc: "alerts.cacheLowDesc" },
  { id: "injection", label: "alerts.injection", desc: "alerts.injectionDesc" },
] as const;

export default function ProviderAlertsField({ value, onChange }: { value: ProviderAlerts; onChange: (value: ProviderAlerts) => void }) {
  const { t } = useTranslation("providers");
  return (
    <div className="flex flex-col gap-1.5" data-testid="provider-alerts-field">
      <span className="text-xs font-medium">{t("alerts.title")}</span>
      <div className="flex flex-col divide-y divide-[var(--app-border)] rounded-md border border-[var(--app-border)]">
        {ROWS.map(({ id, label, desc }) => {
          const switchId = `provider-alert-${id}`;
          return (
            <div key={id} className="flex items-center gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Label htmlFor={switchId} className="text-sm">{t(label)}</Label>
                <p className="m-0 text-xs text-[var(--app-text-tertiary)]">{t(desc)}</p>
              </div>
              <Switch id={switchId} checked={value[id]} onCheckedChange={(checked) => onChange({ ...value, [id]: checked === true })} />
            </div>
          );
        })}
      </div>
      <p className="m-0 text-xs text-[var(--app-text-tertiary)]">{t("alerts.note")}</p>
    </div>
  );
}
