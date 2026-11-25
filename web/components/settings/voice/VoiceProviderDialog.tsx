// 转写服务的连接配置（密钥、地址、模型等），从「转写服务」行的钥匙按钮打开。
// 改动随设置自动保存；「完成」只是关闭。
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { resolveVoiceProvider } from "@/lib/voiceProviders";
import type { VoiceSettings } from "@/types";
import { VOICE_BUTTON_CLASS } from "./VoiceSettingsLayout";

function ToggleField({ id, label, description, checked, onChange }: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>
          {label}
        </label>
        {description ? (
          <p className="m-0 mt-0.5 text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>{description}</p>
        ) : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export default function VoiceProviderDialog({
  open,
  onOpenChange,
  value,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: VoiceSettings;
  onChange: (value: VoiceSettings) => void;
}) {
  const { t } = useTranslation("settings");
  const capability = resolveVoiceProvider(value.provider);
  const update = <K extends keyof VoiceSettings>(key: K, next: VoiceSettings[K]) => onChange({ ...value, [key]: next });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("voiceProviderDialogTitle", { name: t(capability.labelKey) })}</DialogTitle>
          <DialogDescription>{t(capability.hintKey)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <FormField label={t(capability.apiKeyLabelKey)} className="flex flex-col gap-1">
            {({ id }) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                autoFocus
                value={value[capability.apiKeyField]}
                onChange={(event) => update(capability.apiKeyField, event.target.value)}
                placeholder={capability.apiKeyPlaceholderKey ? t(capability.apiKeyPlaceholderKey) : capability.apiKeyPlaceholder}
              />
            )}
          </FormField>

          {capability.baseUrlField ? (
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
          ) : null}

          <div className={capability.showRegion ? "grid grid-cols-2 gap-3" : "flex flex-col"}>
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
            {capability.showRegion ? (
              <div className="flex flex-col gap-1">
                <span className="text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>
                  {t("voiceRegion")}
                </span>
                <Select value={value.region} onValueChange={(next) => update("region", next as VoiceSettings["region"])}>
                  <SelectTrigger aria-label={t("voiceRegion")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="z-[200]">
                    <SelectItem value="cn">{t("voiceRegionCn")}</SelectItem>
                    <SelectItem value="intl">{t("voiceRegionIntl")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          {capability.showEnableItn ? (
            <ToggleField
              id="voice-itn"
              label={t("voiceEnableItn")}
              checked={value.enableItn}
              onChange={(checked) => update("enableItn", checked)}
            />
          ) : null}
          {capability.showPreferWavToggle ? (
            <ToggleField
              id="voice-prefer-wav"
              label={t("voiceCustomPreferWav")}
              description={t("voiceCustomPreferWavDesc")}
              checked={value.customPreferWav}
              onChange={(checked) => update("customPreferWav", checked)}
            />
          ) : null}
        </div>

        <DialogFooter>
          <button
            type="button"
            className={VOICE_BUTTON_CLASS}
            style={{ borderColor: "var(--app-accent)", background: "var(--app-accent)", color: "var(--primary-foreground)" }}
            onClick={() => onOpenChange(false)}
          >
            {t("voiceDone")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
