import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

const AUTO_LANGUAGE_VALUE = "__auto__";

export default function VoiceSection({ value, onChange }: VoiceSectionProps) {
  const { t } = useTranslation("settings");
  const selectedProvider = value.provider ?? "dashscope";

  function update<K extends keyof VoiceSettings>(key: K, next: VoiceSettings[K]) {
    onChange({ ...value, [key]: next });
  }

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
          <Select value={value.region} onValueChange={(next) => update("region", next as VoiceSettings["region"])}>
            <SelectTrigger aria-label={t("voiceRegion")} className="w-full bg-[var(--app-content)] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cn">{t("voiceRegionCn")}</SelectItem>
              <SelectItem value="intl">{t("voiceRegionIntl")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label>{t("voiceLanguage")}</Label>
          <Select
            value={value.language || AUTO_LANGUAGE_VALUE}
            onValueChange={(next) => update("language", next === AUTO_LANGUAGE_VALUE ? null : next)}
          >
            <SelectTrigger aria-label={t("voiceLanguage")} className="w-full bg-[var(--app-content)] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGE_OPTIONS.map((option) => (
                <SelectItem key={option.value || "auto"} value={option.value || AUTO_LANGUAGE_VALUE}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
              <Select
                value={value.language || AUTO_LANGUAGE_VALUE}
                onValueChange={(next) => update("language", next === AUTO_LANGUAGE_VALUE ? null : next)}
              >
                <SelectTrigger aria-label={t("voiceLanguage")} className="w-full bg-[var(--app-content)] text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value || "auto"} value={option.value || AUTO_LANGUAGE_VALUE}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
