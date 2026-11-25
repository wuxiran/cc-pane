import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  CCCHAN_PET_SIZE_DEFAULT,
  CCCHAN_PET_SIZE_MAX,
  CCCHAN_PET_SIZE_MIN,
  FALLBACK_PET,
  useCCChanStore,
} from "@/stores/useCCChanStore";
import { invokeIfTauri } from "@/services/runtime";
import type { CCChanSettings as CCChanSettingsValue } from "@/ccchan/types";
import {
  SettingsRangeControl,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
  SettingsValue,
} from "./layout";

interface CCChanSettingsProps {
  value: CCChanSettingsValue;
  onChange: (value: CCChanSettingsValue) => void;
}

const ENGINE_OPTIONS = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
] as const;

const PET_DESCRIPTION_KEYS = {
  homie: "ccchanPetDescriptionHomie",
  "doro.codex-pet": "ccchanPetDescriptionDoro",
  "ye-shunguang-jk": "ccchanPetDescriptionYeShunguang",
} as const;

export default function CCChanSettings({ value, onChange }: CCChanSettingsProps) {
  const { t } = useTranslation("settings");
  const pets = useCCChanStore((state) => state.pets);
  const load = useCCChanStore((state) => state.load);
  const petOptions = pets.length > 0 ? pets : [FALLBACK_PET];
  const selectedPet = petOptions.find((pet) => pet.id === value.defaultPetId);
  const selectedPetDescriptionKey = selectedPet
    ? PET_DESCRIPTION_KEYS[selectedPet.id as keyof typeof PET_DESCRIPTION_KEYS]
    : undefined;
  const [petsDir, setPetsDir] = useState<string | null>(null);

  useEffect(() => {
    void load();
    invokeIfTauri<string>("get_ccchan_pets_dir")
      .then((dir) => setPetsDir(dir ?? null))
      .catch(() => setPetsDir(null));
  }, [load]);

  function update<K extends keyof CCChanSettingsValue>(key: K, next: CCChanSettingsValue[K]) {
    onChange({ ...value, [key]: next });
  }

  const selectedPetDescription = selectedPetDescriptionKey
    ? t(selectedPetDescriptionKey)
    : selectedPet?.description ?? t("ccchanCurrentPet");

  return (
    <>
      <SettingsSection sectionId="ccchan-companion">
        <SettingsRow
          title={<span id="ccchan-engine-label">{t("ccchanEngine")}</span>}
          control={(
            <div
              className="inline-flex h-8 overflow-hidden rounded-md border border-[var(--app-border)]"
              role="group"
              aria-labelledby="ccchan-engine-label"
            >
              {ENGINE_OPTIONS.map((option) => {
                const active = value.aiEngine === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    className={cn(
                      "min-w-16 px-3 text-[length:var(--text-row)] font-medium transition-colors duration-[var(--dur-fast)]",
                      active
                        ? "bg-[var(--app-accent)] text-[var(--primary-foreground)]"
                        : "bg-[var(--app-content)] text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)]",
                    )}
                    onClick={() => update("aiEngine", option.value)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}
        />
        <SettingsRow
          title={t("ccchanDefaultPet")}
          description={selectedPetDescription}
          htmlFor="ccchan-default-pet"
          control={(
            <Select value={value.defaultPetId} onValueChange={(next) => update("defaultPetId", next)}>
              <SelectTrigger id="ccchan-default-pet" aria-label={t("ccchanDefaultPet")} className="w-44 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {petOptions.map((pet) => (
                  <SelectItem key={pet.id} value={pet.id}>{pet.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </SettingsSection>

      <SettingsSection sectionId="ccchan-behavior">
        <SettingsSwitchRow
          id="ccchan-auto-start"
          title={t("ccchanAutoStart")}
          checked={value.autoStart}
          onCheckedChange={(checked) => update("autoStart", checked)}
        />
        <SettingsSwitchRow
          id="ccchan-sound-enabled"
          title={t("ccchanSoundEnabled")}
          checked={value.soundEnabled}
          onCheckedChange={(checked) => update("soundEnabled", checked)}
        />
        <SettingsSwitchRow
          id="ccchan-window-visible"
          title={t("ccchanWindowVisible")}
          checked={value.windowVisible}
          onCheckedChange={(checked) => update("windowVisible", checked)}
        />
        <SettingsSwitchRow
          id="ccchan-wander-enabled"
          title={t("ccchanWanderEnabled")}
          description={t("ccchanWanderHint")}
          checked={value.wanderEnabled}
          onCheckedChange={(checked) => update("wanderEnabled", checked)}
        />
      </SettingsSection>

      <SettingsSection sectionId="ccchan-appearance">
        <SettingsRow
          title={t("ccchanPetSize")}
          htmlFor="ccchan-pet-size"
          control={(
            <>
              <SettingsRangeControl
                id="ccchan-pet-size"
                value={value.petSize}
                min={CCCHAN_PET_SIZE_MIN}
                max={CCCHAN_PET_SIZE_MAX}
                step={10}
                format={(size) => `${size}px`}
                onChange={(size) => update("petSize", size)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={value.petSize === CCCHAN_PET_SIZE_DEFAULT}
                onClick={() => update("petSize", CCCHAN_PET_SIZE_DEFAULT)}
              >
                {t("ccchanPetSizeReset")}
              </Button>
            </>
          )}
        />
        <SettingsRow
          title={t("ccchanSkinDir")}
          description={t("ccchanSkinDirHint")}
          control={(
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void invokeIfTauri("open_ccchan_pets_dir").catch(() => {})}
              >
                <FolderOpen size={13} className="mr-1" />
                {t("ccchanOpenSkinDir")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void load()}
              >
                <RefreshCw size={13} className="mr-1" />
                {t("ccchanRefreshPets")}
              </Button>
            </>
          )}
        >
          {petsDir ? <SettingsValue title={petsDir}>{petsDir}</SettingsValue> : null}
        </SettingsRow>
        <SettingsRow
          title={t("ccchanPosition")}
          control={(
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onChange({ ...value, windowX: null, windowY: null })}
            >
              {t("ccchanResetPosition")}
            </Button>
          )}
        >
          <SettingsValue>
            x: {value.windowX ?? "-"} · y: {value.windowY ?? "-"} · {value.petSize}x{value.petSize}
          </SettingsValue>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
