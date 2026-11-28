// Bot 的「桌面形象」：桌宠代表这个 Bot 时用哪个皮肤（含预览帧）。
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { PetThumb } from "@/ccchan/SpritePet";
import { useCCChanStore } from "@/stores/useCCChanStore";

interface BotPetPickerProps {
  value: string | null | undefined;
  onChange: (petId: string | null) => void;
}

export default function BotPetPicker({ value, onChange }: BotPetPickerProps) {
  const { t } = useTranslation("sidebar");
  const pets = useCCChanStore((state) => state.pets);
  const load = useCCChanStore((state) => state.load);
  const loaded = useCCChanStore((state) => state.loaded);

  useEffect(() => {
    if (!loaded) void load();
  }, [load, loaded]);

  const option = (selected: boolean) => cn(
    "flex w-16 flex-col items-center gap-1 rounded-md border px-1 py-1.5 text-[length:var(--text-micro)] transition-colors",
    selected
      ? "border-[var(--app-accent)] bg-[var(--app-hover)] text-[var(--app-text-primary)]"
      : "border-[var(--app-border)] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)]",
  );

  return (
    <div className="flex flex-col gap-1.5" data-testid="bot-pet-picker">
      <span className="text-[length:var(--text-small)]">{t("bots.pet")}</span>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("bots.pet")}>
        <button type="button" role="radio" aria-checked={!value} className={option(!value)} onClick={() => onChange(null)}>
          <span className="flex h-10 w-10 items-center justify-center text-[length:var(--text-caption)]">—</span>
          <span className="w-full truncate text-center">{t("bots.petDefault")}</span>
        </button>
        {pets.map((pet) => (
          <button
            key={pet.id}
            type="button"
            role="radio"
            aria-checked={value === pet.id}
            title={pet.description || pet.displayName}
            className={option(value === pet.id)}
            onClick={() => onChange(pet.id)}
          >
            <PetThumb pet={pet} size={40} />
            <span className="w-full truncate text-center">{pet.displayName}</span>
          </button>
        ))}
      </div>
      <span className="text-[length:var(--text-micro)] text-[var(--app-text-muted)]">{t("bots.petHint")}</span>
    </div>
  );
}
