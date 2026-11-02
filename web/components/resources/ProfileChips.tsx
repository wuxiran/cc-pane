// 一排启动档开关。不能切换的开关仍可点击，点击后由所在行把原因写在行内。
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { allChipState, type ChipBlockReason, type ProfileChipState } from "./resourceCenterModel";

export interface ProfileChipItem {
  profileId: string;
  label: string;
  state: ProfileChipState;
}

interface ProfileChipsProps {
  /** 资源名，读屏时用来区分不同行的同名开关 */
  resourceName: string;
  items: readonly ProfileChipItem[];
  onChange: (profileId: string, on: boolean) => void;
  onBlocked: (reason: ChipBlockReason, profileId: string) => void;
}

function chipClass(on: boolean, blocked: boolean) {
  return cn(
    "inline-flex h-6 max-w-40 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors",
    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    on
      ? "border-[color-mix(in_srgb,var(--app-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--app-accent)_16%,transparent)] text-[var(--app-accent)]"
      : "border-[var(--app-home-border)] text-[var(--app-text-secondary)] hover:bg-accent",
    blocked && "border-dashed text-[var(--app-text-tertiary)] hover:bg-transparent",
  );
}

export default function ProfileChips({ resourceName, items, onChange, onBlocked }: ProfileChipsProps) {
  const { t } = useTranslation("settings");
  const all = allChipState(items.map((item) => item.state));

  return (
    <div className="flex flex-wrap items-center justify-end gap-1" role="group" aria-label={t("resourceCenter.chipsLabel", { name: resourceName })}>
      {all.available && (
        <button
          type="button"
          aria-pressed={all.on}
          data-testid="profile-chip-all"
          className={chipClass(all.on, false)}
          onClick={() => {
            for (const item of items) {
              if (!item.state.blocked && item.state.on !== !all.on) onChange(item.profileId, !all.on);
            }
          }}
        >
          {t("resourceCenter.all")}
        </button>
      )}
      {items.map((item) => {
        const blocked = item.state.blocked;
        return (
          <button
            key={item.profileId}
            type="button"
            aria-pressed={item.state.on}
            aria-disabled={blocked ? true : undefined}
            data-testid="profile-chip"
            data-profile-id={item.profileId}
            className={chipClass(item.state.on, Boolean(blocked))}
            onClick={() => (blocked ? onBlocked(blocked, item.profileId) : onChange(item.profileId, !item.state.on))}
          >
            {blocked && <Lock size={10} aria-hidden="true" className="shrink-0" />}
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
