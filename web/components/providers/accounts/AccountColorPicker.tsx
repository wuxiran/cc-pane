import { useTranslation } from "react-i18next";
import { Ban } from "lucide-react";
import { ACCOUNT_COLORS, accountColorVar, isAccountColor } from "@/utils/providerAccounts";

interface AccountColorPickerProps {
  value: string | null;
  onChange: (color: string | null) => void;
}

/** 账号颜色：与工作空间同一套 `--app-tag-*` 色；可以不设。 */
export default function AccountColorPicker({ value, onChange }: AccountColorPickerProps) {
  const { t } = useTranslation("providers");
  const selected = isAccountColor(value) ? value : null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t("providerAccounts.account.color")}>
      {ACCOUNT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={selected === color}
          aria-label={t(`providerAccounts.colorName.${color}`)}
          className="flex size-6 items-center justify-center rounded-full border transition-colors"
          style={{ borderColor: selected === color ? "var(--app-text-primary)" : "transparent" }}
          onClick={() => onChange(color)}
        >
          <span className="size-4 rounded-full" style={{ backgroundColor: accountColorVar(color) }} />
        </button>
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={selected === null}
        aria-label={t("providerAccounts.account.colorNone")}
        className="flex size-6 items-center justify-center rounded-full border text-[var(--app-text-tertiary)]"
        style={{ borderColor: selected === null ? "var(--app-text-primary)" : "var(--app-border)" }}
        onClick={() => onChange(null)}
      >
        <Ban size={12} />
      </button>
    </div>
  );
}
