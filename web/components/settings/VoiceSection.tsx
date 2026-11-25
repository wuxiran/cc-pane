// 语音输入设置，版式参照 t3code：输入 / 转写 / 词典 / 其他 四组，
// 每行左边标题说明、右边控件。转写服务选「关闭」即停用语音输入。
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { isLocalVoice } from "@/lib/voiceProviders";
import type { VoiceSettings } from "@/types";
import DictionaryEditor from "./voice/DictionaryEditor";
import MicrophoneSettings from "./voice/MicrophoneSettings";
import TranscriptionSettings from "./voice/TranscriptionSettings";
import { VoiceGroup, VoiceRow } from "./voice/VoiceSettingsLayout";

interface VoiceSectionProps {
  value: VoiceSettings;
  onChange: (value: VoiceSettings) => void;
}

export default function VoiceSection({ value, onChange }: VoiceSectionProps) {
  const { t } = useTranslation("settings");
  const update = <K extends keyof VoiceSettings>(key: K, next: VoiceSettings[K]) => onChange({ ...value, [key]: next });

  return (
    <div className="flex flex-col gap-5">
      <VoiceGroup id="voice-transcription" title={t("voiceGroupTranscription")}>
        <TranscriptionSettings value={value} onChange={onChange} />
      </VoiceGroup>

      {value.enabled ? (
        <>
          <VoiceGroup id="voice-input" title={t("voiceGroupInput")}>
            <MicrophoneSettings saved={value.microphones} onChange={(microphones) => update("microphones", microphones)} />
          </VoiceGroup>

          <VoiceGroup id="voice-dictionary" title={t("voiceGroupDictionary")}>
            <VoiceRow
              title={t("voiceDictionary")}
              description={
                // SenseVoice 没有热词接口，词典只对 Qwen3-ASR 和云端服务生效
                isLocalVoice(value) && value.localModel !== "qwen3-asr" ? t("voiceDictionaryLocalUnsupported") : t("voiceDictionaryDesc")
              }
            >
              <DictionaryEditor words={value.customWords ?? []} onChange={(words) => update("customWords", words)} />
            </VoiceRow>
          </VoiceGroup>

          <VoiceGroup id="voice-advanced" title={t("voiceGroupAdvanced")}>
            <VoiceRow
              title={t("voiceShowFloatingButton")}
              description={t("voiceShowFloatingButtonDesc")}
              htmlFor="voice-floating-button"
              control={
                <Switch
                  id="voice-floating-button"
                  checked={value.showFloatingButton}
                  onCheckedChange={(checked) => update("showFloatingButton", checked)}
                />
              }
            />
            <VoiceRow
              title={t("voiceMaxRecordSeconds")}
              description={t("voiceMaxRecordSecondsDesc")}
              htmlFor="voice-max-seconds"
              control={
                <span className="flex items-center gap-1.5">
                  <Input
                    id="voice-max-seconds"
                    type="number"
                    min={1}
                    max={300}
                    className="h-8 w-20 text-right"
                    value={value.maxRecordSeconds}
                    onChange={(event) => update("maxRecordSeconds", Number(event.target.value))}
                  />
                  <span className="text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("voiceSecondsUnit")}
                  </span>
                </span>
              }
            />
          </VoiceGroup>
        </>
      ) : null}
    </div>
  );
}
