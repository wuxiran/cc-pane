import { useTranslation } from "react-i18next";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { resolveVoiceProvider, VOICE_PROVIDERS, VOICE_PROVIDER_IDS } from "@/lib/voiceProviders";
import type { VoiceSettings } from "@/types";

interface VoiceSectionProps {
  value: VoiceSettings;
  onChange: (value: VoiceSettings) => void;
}

const LANGUAGE_OPTIONS = [
  { value: "", labelKey: "voiceLanguageAuto" },
  { value: "zh", labelKey: "voiceLanguageZh" },
  { value: "yue", labelKey: "voiceLanguageYue" },
  { value: "en", labelKey: "voiceLanguageEn" },
  { value: "ja", labelKey: "voiceLanguageJa" },
  { value: "ko", labelKey: "voiceLanguageKo" },
] as const;

export default function VoiceSection({ value, onChange }: VoiceSectionProps) {
  const { t } = useTranslation("settings");
  const capability = resolveVoiceProvider(value.provider);

  function update<K extends keyof VoiceSettings>(key: K, next: VoiceSettings[K]) {
    onChange({ ...value, [key]: next });
  }

  const selectClassName = "h-9 rounded-md px-2 text-[13px] outline-none";
  const selectStyle = {
    border: "1px solid var(--app-border)",
    background: "var(--app-content)",
    color: "var(--app-text-primary)",
  };

  const languageSelect = (
    <div className="flex flex-col gap-1">
      <Label htmlFor="voice-language">{t("voiceLanguage")}</Label>
      <select
        id="voice-language"
        aria-label={t("voiceLanguage")}
        value={value.language ?? ""}
        onChange={(event) => update("language", event.target.value || null)}
        className={selectClassName}
        style={selectStyle}
      >
        {LANGUAGE_OPTIONS.map((option) => (
          <option key={option.value || "auto"} value={option.value}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
    </div>
  );

  const maxRecordSecondsInput = (
    <FormField label={t("voiceMaxRecordSeconds")} className="flex flex-col gap-1">
      {({ id }) => (
        <Input
          id={id}
          type="number"
          min={1}
          max={300}
          value={value.maxRecordSeconds}
          onChange={(event) => update("maxRecordSeconds", Number(event.target.value))}
        />
      )}
    </FormField>
  );

  const modelInput = (
    <FormField label={t("voiceModel")} className="flex flex-col gap-1">
      {({ id }) => (
        <Input
          id={id}
          value={value[capability.modelField]}
          onChange={(event) => update(capability.modelField, event.target.value)}
          placeholder={capability.modelPlaceholder}
        />
      )}
    </FormField>
  );

  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => update("enabled", event.target.checked)}
          className="h-4 w-4 cursor-pointer"
          style={{ accentColor: "var(--app-accent)" }}
        />
        {t("voiceEnable")}
      </label>

      <div className="flex flex-col gap-0.5">
        <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
          <input
            type="checkbox"
            checked={value.showFloatingButton}
            onChange={(event) => update("showFloatingButton", event.target.checked)}
            className="h-4 w-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
          {t("voiceShowFloatingButton", { defaultValue: "在终端显示悬浮按钮" })}
        </label>
        <p className="text-[12px] pl-6 m-0" style={{ color: "var(--app-text-tertiary)" }}>
          {t("voiceShowFloatingButtonDesc", {
            defaultValue: "关闭后终端右下角不再显示麦克风按钮；语音快捷键仍然可用。",
          })}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label id="voice-provider-label">{t("voiceProvider")}</Label>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="voice-provider-label">
          {VOICE_PROVIDER_IDS.map((providerId) => {
            const option = VOICE_PROVIDERS[providerId];
            const active = capability.id === providerId;
            return (
              <button
                key={providerId}
                type="button"
                onClick={() => update("provider", providerId)}
                className={cn(
                  "h-9 rounded-md border px-3 text-[13px] font-medium transition-colors",
                  active
                    ? "border-[var(--app-accent)] bg-[var(--app-accent)] text-white"
                    : "border-[var(--app-border)] bg-[var(--app-content)] text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)]"
                )}
              >
                {t(option.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      <FormField label={t(capability.apiKeyLabelKey)} className="flex flex-col gap-1">
        {({ id }) => (
          <Input
            id={id}
            type="password"
            value={value[capability.apiKeyField]}
            onChange={(event) => update(capability.apiKeyField, event.target.value)}
            placeholder={capability.apiKeyPlaceholder}
          />
        )}
      </FormField>

      {capability.baseUrlField ? (
        <div className="grid grid-cols-[1fr_180px] gap-3">
          <FormField label={t(capability.baseUrlLabelKey ?? "voiceMimoBaseUrl")} className="flex flex-col gap-1">
            {({ id }) => (
              <Input
                id={id}
                value={value[capability.baseUrlField!]}
                onChange={(event) => update(capability.baseUrlField!, event.target.value)}
                placeholder={capability.baseUrlPlaceholder}
              />
            )}
          </FormField>
          {modelInput}
        </div>
      ) : null}

      {capability.showRegion ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="voice-region">{t("voiceRegion")}</Label>
              <select
                id="voice-region"
                aria-label={t("voiceRegion")}
                value={value.region}
                onChange={(event) => update("region", event.target.value as VoiceSettings["region"])}
                className={selectClassName}
                style={selectStyle}
              >
                <option value="cn">{t("voiceRegionCn")}</option>
                <option value="intl">{t("voiceRegionIntl")}</option>
              </select>
            </div>
            {languageSelect}
          </div>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            {modelInput}
            {maxRecordSecondsInput}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-[1fr_120px] gap-3">
          {languageSelect}
          {maxRecordSecondsInput}
        </div>
      )}

      {capability.showEnableItn ? (
        <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
          <input
            type="checkbox"
            checked={value.enableItn}
            onChange={(event) => update("enableItn", event.target.checked)}
            className="h-4 w-4 cursor-pointer"
            style={{ accentColor: "var(--app-accent)" }}
          />
          {t("voiceEnableItn")}
        </label>
      ) : null}

      {capability.showPreferWavToggle ? (
        <div className="flex flex-col gap-0.5">
          <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--app-text-primary)" }}>
            <input
              type="checkbox"
              checked={value.customPreferWav}
              onChange={(event) => update("customPreferWav", event.target.checked)}
              className="h-4 w-4 cursor-pointer"
              style={{ accentColor: "var(--app-accent)" }}
            />
            {t("voiceCustomPreferWav")}
          </label>
          <p className="text-[12px] pl-6 m-0" style={{ color: "var(--app-text-tertiary)" }}>
            {t("voiceCustomPreferWavDesc")}
          </p>
        </div>
      ) : null}

      <p className="text-[11px] leading-5" style={{ color: "var(--app-text-tertiary)" }}>
        {t(capability.hintKey)}
      </p>
    </div>
  );
}
