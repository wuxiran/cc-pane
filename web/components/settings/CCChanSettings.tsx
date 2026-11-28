import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CCCHAN_PET_SIZE_DEFAULT,
  CCCHAN_PET_SIZE_MAX,
  CCCHAN_PET_SIZE_MIN,
  FALLBACK_PET,
  useCCChanStore,
} from "@/stores/useCCChanStore";
import { invokeIfTauri } from "@/services/runtime";
import { botService } from "@/services/botService";
import type { BotSummary } from "@/types/bot";
import { SegmentedTabs } from "@/components/ui/segmented";
import type {
  CCChanAppearance,
  CCChanOrbSort,
  CCChanSettings as CCChanSettingsValue,
} from "@/ccchan/types";
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

/** Select 不接受空字符串值：「自动」用哨兵值表示未指定 Bot。 */
const AUTO_BOT = "__auto__";

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
  const [bots, setBots] = useState<BotSummary[]>([]);

  useEffect(() => {
    let disposed = false;
    const reload = () => {
      botService.list().then((list) => { if (!disposed) setBots(list); }).catch(() => {});
    };
    reload();
    let unlisten: (() => void) | undefined;
    void botService.listenChanged(reload).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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

  const isOrb = value.appearance === "orb";

  return (
    <>
      <SettingsSection sectionId="ccchan-form">
        <SettingsRow
          title={t("ccchanAppearance")}
          description={isOrb ? t("ccchanAppearanceOrbHint") : t("ccchanAppearancePetHint")}
          control={(
            <SegmentedTabs<CCChanAppearance>
              size="sm"
              aria-label={t("ccchanAppearance")}
              value={value.appearance}
              onValueChange={(next) => update("appearance", next)}
              items={[
                { value: "pet", label: t("ccchanAppearancePet") },
                { value: "orb", label: t("ccchanAppearanceOrb") },
              ]}
            />
          )}
        />
        {isOrb ? (
          <>
            <SettingsRow
              title={t("ccchanOrbSort")}
              description={t("ccchanOrbSortHint")}
              control={(
                <SegmentedTabs<CCChanOrbSort>
                  size="sm"
                  aria-label={t("ccchanOrbSort")}
                  value={value.orbSort}
                  onValueChange={(next) => update("orbSort", next)}
                  items={[
                    { value: "recent", label: t("ccchanOrbSortRecent") },
                    { value: "attention", label: t("ccchanOrbSortAttention") },
                  ]}
                />
              )}
            />
            <SettingsSwitchRow
              id="ccchan-orb-hover-switch"
              title={t("ccchanOrbHoverSwitch")}
              description={t("ccchanOrbHoverSwitchHint")}
              checked={value.orbHoverSwitch}
              onCheckedChange={(checked) => update("orbHoverSwitch", checked)}
            />
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection sectionId="ccchan-companion">
        <SettingsRow
          title={t("ccchanActiveBot")}
          description={bots.length === 0 ? t("ccchanActiveBotEmpty") : t("ccchanActiveBotHint")}
          htmlFor="ccchan-active-bot"
          control={(
            <Select
              value={value.activeBotId && bots.some((bot) => bot.id === value.activeBotId) ? value.activeBotId : AUTO_BOT}
              onValueChange={(next) => update("activeBotId", next === AUTO_BOT ? null : next)}
            >
              <SelectTrigger id="ccchan-active-bot" aria-label={t("ccchanActiveBot")} className="w-44 shrink-0 bg-[var(--app-content)] text-[length:var(--text-row)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_BOT}>{t("ccchanActiveBotAuto")}</SelectItem>
                {bots.map((bot) => (
                  <SelectItem key={bot.id} value={bot.id}>{bot.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          id="ccchan-window-visible"
          title={t("ccchanWindowVisible")}
          checked={value.windowVisible}
          onCheckedChange={(checked) => update("windowVisible", checked)}
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
              onClick={() => onChange({ ...value, windowX: null, windowY: null, windowPosPhysical: true })}
            >
              {t("ccchanResetPosition")}
            </Button>
          )}
        >
          <SettingsValue>
            x: {value.windowX ?? "-"} · y: {value.windowY ?? "-"} · {value.petSize}px
          </SettingsValue>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
