import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { envKeepsStoredValue, envNeedsRefill, newEnvDraft, type EnvDraft } from "./drafts";

interface EnvVarsEditorProps {
  entries: EnvDraft[];
  onChange: (entries: EnvDraft[]) => void;
  /** 区分供应商一级 / 账号一级的输入框，便于读屏和测试定位。 */
  scopeLabel: string;
}

const MAX_ENTRIES = 64;

/**
 * 「名字 / 值 / 敏感」表格。敏感值保存后不回显：输入框空着，占位写「已保存，留空保持」；
 * 改了名或取消了敏感，旧值不会跟过来，要求重填。
 */
export default function EnvVarsEditor({ entries, onChange, scopeLabel }: EnvVarsEditorProps) {
  const { t } = useTranslation("providers");
  const update = (key: string, patch: Partial<EnvDraft>) =>
    onChange(entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));

  return (
    <div className="flex flex-col gap-2" role="group" aria-label={scopeLabel}>
      {entries.length === 0 ? (
        <div
          className="rounded-md border border-dashed px-3 py-3 text-center text-xs"
          style={{ borderColor: "var(--app-border)", color: "var(--app-text-tertiary)" }}
        >
          {t("providerAccounts.env.empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem_1.75rem] gap-2 px-0.5 text-[length:var(--text-caption)]"
            style={{ color: "var(--app-text-tertiary)" }}
            aria-hidden="true"
          >
            <span>{t("providerAccounts.env.name")}</span>
            <span>{t("providerAccounts.env.value")}</span>
            <span>{t("providerAccounts.env.sensitive")}</span>
            <span />
          </div>
          {entries.map((entry, index) => {
            const keeps = envKeepsStoredValue(entry);
            const refill = envNeedsRefill(entry);
            const placeholder = refill
              ? t("providerAccounts.env.refillPlaceholder")
              : keeps
                ? t("providerAccounts.env.storedPlaceholder")
                : "";
            return (
              <div key={entry.key} className="flex flex-col gap-1">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem_1.75rem] items-center gap-2">
                  <Input
                    aria-label={t("providerAccounts.env.nameAria", { scope: scopeLabel, index: index + 1 })}
                    className="h-8 font-mono text-xs"
                    value={entry.name}
                    maxLength={256}
                    onChange={(event) => update(entry.key, { name: event.target.value })}
                    placeholder="API_TIMEOUT_MS"
                  />
                  <Input
                    aria-label={t("providerAccounts.env.valueAria", { scope: scopeLabel, index: index + 1 })}
                    aria-invalid={refill || undefined}
                    className="h-8 font-mono text-xs"
                    type={entry.sensitive ? "password" : "text"}
                    value={entry.value}
                    onChange={(event) => update(entry.key, { value: event.target.value })}
                    placeholder={placeholder}
                    style={refill ? { borderColor: "var(--app-status-warning)" } : undefined}
                  />
                  <div className="flex items-center justify-center">
                    <Checkbox
                      aria-label={t("providerAccounts.env.sensitiveAria", { scope: scopeLabel, index: index + 1 })}
                      checked={entry.sensitive}
                      onCheckedChange={(checked) => update(entry.key, { sensitive: checked === true })}
                    />
                  </div>
                  <IconTooltipButton
                    label={t("providerAccounts.env.remove")}
                    className="h-7 w-7"
                    onClick={() => onChange(entries.filter((item) => item.key !== entry.key))}
                  >
                    <X size={13} />
                  </IconTooltipButton>
                </div>
                {refill && (
                  <p className="text-[length:var(--text-caption)]" style={{ color: "var(--app-status-warning)" }}>
                    {t("providerAccounts.env.refillHint")}
                  </p>
                )}
                {keeps && entry.storage !== "none" && (
                  <p className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
                    {t(`providerAccounts.env.storage.${entry.storage}`)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-fit px-2 text-xs"
        disabled={entries.length >= MAX_ENTRIES}
        onClick={() => onChange([...entries, newEnvDraft()])}
      >
        <Plus size={13} /> {t("providerAccounts.env.add")}
      </Button>
    </div>
  );
}
