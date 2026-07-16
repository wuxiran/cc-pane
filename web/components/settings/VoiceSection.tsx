import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
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

const PROVIDER_OPTIONS = [
  { value: "dashscope", labelKey: "voiceProviderDashscope" },
  { value: "mimo", labelKey: "voiceProviderMimo" },
] as const;

export default function VoiceSection({ value, onChange }: VoiceSectionProps) {
  const { t } = useTranslation("settings");
  const selectedProvider = value.provider ?? "dashscope";

  function update<K extends keyof VoiceSettings>(key: K, next: VoiceSettings[K]) {
    onChange({ ...value, [key]: next });
  }

  const selectClassName = "h-9 rounded-md px-2 text-[13px] outline-none";
  const selectStyle = {
    border: "1px solid var(--app-border)",
    background: "var(--app-content)",
    color: "var(--app-text-primary)",
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
          {t("voiceTitle")}
        </h3>
        <p className="text-[12px]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("voiceDesc")}
        </p>
      </div>

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
        <Label>{t("voiceProvider")}</Label>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_OPTIONS.map((option) => {
            const active = selectedProvider === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => update("provider", option.value)}
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

      {selectedProvider === "dashscope" ? (
        <>
      <div className="flex flex-col gap-1">
        <Label>{t("voiceDashscopeApiKey")}</Label>
        <Input
          type="password"
          value={value.dashscopeApiKey}
          onChange={(event) => update("dashscopeApiKey", event.target.value)}
          placeholder="sk-..."
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label>{t("voiceRegion")}</Label>
          <select
            value={value.region}
            onChange={(event) => update("region", event.target.value as VoiceSettings["region"])}
            className={selectClassName}
            style={selectStyle}
          >
            <option value="cn">{t("voiceRegionCn")}</option>
            <option value="intl">{t("voiceRegionIntl")}</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <Label>{t("voiceLanguage")}</Label>
          <select
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
      </div>

      <div className="grid grid-cols-[1fr_120px] gap-3">
        <div className="flex flex-col gap-1">
          <Label>{t("voiceModel")}</Label>
          <Input
            value={value.model}
            onChange={(event) => update("model", event.target.value)}
            placeholder="qwen3-asr-flash"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label>{t("voiceMaxRecordSeconds")}</Label>
          <Input
            type="number"
            min={1}
            max={300}
            value={value.maxRecordSeconds}
            onChange={(event) => update("maxRecordSeconds", Number(event.target.value))}
          />
        </div>
      </div>

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

      <p className="text-[11px] leading-5" style={{ color: "var(--app-text-tertiary)" }}>
        {t("voiceLimitHint")}
      </p>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <Label>{t("voiceMimoApiKey")}</Label>
            <Input
              type="password"
              value={value.mimoApiKey}
              onChange={(event) => update("mimoApiKey", event.target.value)}
              placeholder="mimo-..."
            />
          </div>

          <div className="grid grid-cols-[1fr_180px] gap-3">
            <div className="flex flex-col gap-1">
              <Label>{t("voiceMimoBaseUrl")}</Label>
              <Input
                value={value.mimoBaseUrl}
                onChange={(event) => update("mimoBaseUrl", event.target.value)}
                placeholder="https://api.xiaomimimo.com/v1"
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label>{t("voiceModel")}</Label>
              <Input
                value={value.mimoModel}
                onChange={(event) => update("mimoModel", event.target.value)}
                placeholder="mimo-v2.5"
              />
            </div>
          </div>

          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="flex flex-col gap-1">
              <Label>{t("voiceLanguage")}</Label>
              <select
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

            <div className="flex flex-col gap-1">
              <Label>{t("voiceMaxRecordSeconds")}</Label>
              <Input
                type="number"
                min={1}
                max={300}
                value={value.maxRecordSeconds}
                onChange={(event) => update("maxRecordSeconds", Number(event.target.value))}
              />
            </div>
          </div>

          <p className="text-[11px] leading-5" style={{ color: "var(--app-text-tertiary)" }}>
            {t("voiceMimoHint")}
          </p>
        </>
      )}
    </div>
  );
}
