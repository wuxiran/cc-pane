// 「转写」分组：转写服务（含关闭）、语种、去语气词、试转写。
import { useState } from "react";
import { AudioLines, HardDrive, KeyRound, Loader2, Mic, MicOff, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { blobToAudioPayload } from "@/lib/voiceAudio";
import { preferredMicrophoneId, effectiveMicrophoneOrder } from "@/lib/voiceMicrophones";
import {
  isLocalVoice,
  LOCAL_VOICE_PROVIDER,
  missingApiKey,
  REMOTE_VOICE_PROVIDER_IDS,
  resolveVoiceProvider,
  shouldPreferWav,
  VOICE_PROVIDERS,
  wavSampleRate,
  type VoiceProviderId,
} from "@/lib/voiceProviders";
import { finalizeTranscript } from "@/lib/voiceTranscript";
import { voiceService } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import type { VoiceSettings } from "@/types";
import { RECORDER_ERROR_KEYS, useAudioInputs } from "./MicrophoneSettings";
import LocalModelDialog, { localModelInfo } from "./LocalModelDialog";
import { localModelReady, useLocalVoice } from "./useLocalVoice";
import { formatClock, useVoiceRecorder } from "./useVoiceRecorder";
import VoiceProviderDialog from "./VoiceProviderDialog";
import {
  RecordingDot,
  VoiceInlinePanel,
  VoiceLevelBars,
  VoiceRow,
  VOICE_BUTTON_CLASS,
  VOICE_BUTTON_STYLE,
  VOICE_ICON_BUTTON_CLASS,
} from "./VoiceSettingsLayout";

const OFF = "off";
const TEST_MAX_SECONDS = 30;

const LANGUAGE_OPTIONS = [
  { value: "auto", labelKey: "voiceLanguageAuto" },
  { value: "zh", labelKey: "voiceLanguageZh" },
  { value: "yue", labelKey: "voiceLanguageYue" },
  { value: "en", labelKey: "voiceLanguageEn" },
  { value: "ja", labelKey: "voiceLanguageJa" },
  { value: "ko", labelKey: "voiceLanguageKo" },
] as const;

export default function TranscriptionSettings({ value, onChange }: { value: VoiceSettings; onChange: (value: VoiceSettings) => void }) {
  const { t } = useTranslation("settings");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [localDialogOpen, setLocalDialogOpen] = useState(false);
  const local = isLocalVoice(value);
  const capability = resolveVoiceProvider(value.provider);
  const destination = !value.enabled ? OFF : local ? LOCAL_VOICE_PROVIDER : capability.id;
  const keyMissing = value.enabled && missingApiKey(value);
  const localController = useLocalVoice((value.enabled && local) || localDialogOpen);
  const localReady = localModelReady(localController.status, value.localModel);
  const localPending = value.enabled && local && !localReady;
  const modelName = t(localModelInfo(value.localModel).nameKey);

  const choose = (next: string) => {
    if (next === OFF) {
      onChange({ ...value, enabled: false });
      return;
    }
    const provider = next as VoiceProviderId;
    const updated = { ...value, enabled: true, provider };
    onChange(updated);
    // 选了还没就绪的服务（缺密钥 / 本地模型没下载），直接把配置窗打开
    if (provider === LOCAL_VOICE_PROVIDER) {
      if (!localModelReady(localController.status, updated.localModel)) setLocalDialogOpen(true);
    } else if (missingApiKey(updated)) {
      setDialogOpen(true);
    }
  };

  let description = t("voiceTranscribeWithDesc");
  if (value.enabled && local) description = localReady ? t("voiceLocalReady", { model: modelName }) : t("voiceLocalNotReady");
  else if (keyMissing) description = t("voiceTranscribeWithKeyMissing");
  else if (value.enabled) description = t(capability.hintKey);

  return (
    <>
      <VoiceRow
        title={t("voiceTranscribeWith")}
        description={description}
        control={
          <>
            <Select value={destination} onValueChange={choose}>
              <SelectTrigger size="sm" aria-label={t("voiceTranscribeWith")} className="w-[220px]">
                <SelectValue>
                  <span className="flex min-w-0 items-center gap-2">
                    {value.enabled ? <AudioLines className="size-3.5 shrink-0" aria-hidden="true" /> : <MicOff className="size-3.5 shrink-0" aria-hidden="true" />}
                    <span className="truncate">{!value.enabled ? t("voiceOff") : local ? t("voiceProviderLocal") : t(capability.labelKey)}</span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value={OFF}>{t("voiceOff")}</SelectItem>
                <SelectSeparator />
                <SelectItem value={LOCAL_VOICE_PROVIDER}>{t("voiceProviderLocal")}</SelectItem>
                <SelectSeparator />
                {REMOTE_VOICE_PROVIDER_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {t(VOICE_PROVIDERS[id].labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {value.enabled && local ? (
              <button
                type="button"
                className={VOICE_ICON_BUTTON_CLASS}
                style={{ color: localPending ? "var(--app-status-warning)" : "var(--app-text-secondary)" }}
                aria-label={t("voiceManageLocalModels")}
                title={t("voiceManageLocalModels")}
                onClick={() => setLocalDialogOpen(true)}
              >
                <HardDrive aria-hidden="true" />
              </button>
            ) : value.enabled ? (
              <button
                type="button"
                className={VOICE_ICON_BUTTON_CLASS}
                style={{ color: keyMissing ? "var(--app-status-warning)" : "var(--app-text-secondary)" }}
                aria-label={t("voiceManageConnection")}
                title={t("voiceManageConnection")}
                onClick={() => setDialogOpen(true)}
              >
                <KeyRound aria-hidden="true" />
              </button>
            ) : null}
          </>
        }
      />
      <VoiceProviderDialog open={dialogOpen && !local} onOpenChange={setDialogOpen} value={value} onChange={onChange} />
      <LocalModelDialog open={localDialogOpen} onOpenChange={setLocalDialogOpen} value={value} onChange={onChange} controller={localController} />

      {value.enabled ? (
        <>
          <VoiceRow
            title={t("voiceLanguage")}
            description={t("voiceLanguageDesc")}
            control={
              <Select value={value.language ?? "auto"} onValueChange={(next) => onChange({ ...value, language: next === "auto" ? null : next })}>
                <SelectTrigger size="sm" aria-label={t("voiceLanguage")} className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {LANGUAGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{t(option.labelKey)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <VoiceRow
            title={t("voiceRemoveFillerWords")}
            description={t("voiceRemoveFillerWordsDesc")}
            htmlFor="voice-remove-filler"
            control={
              <Switch
                id="voice-remove-filler"
                checked={value.removeFillerWords ?? true}
                onCheckedChange={(checked) => onChange({ ...value, removeFillerWords: checked })}
              />
            }
          />
          <TranscriptionTest
            value={value}
            blockedReason={keyMissing ? t("voiceTranscribeWithKeyMissing") : localPending ? t("voiceLocalNotReady") : null}
          />
        </>
      ) : null}
    </>
  );
}

type TestResult = { kind: "text"; text: string } | { kind: "error"; message: string } | { kind: "transcribing" };

function TranscriptionTest({ value, blockedReason }: { value: VoiceSettings; blockedReason: string | null }) {
  const { t } = useTranslation("settings");
  const { devices, refresh } = useAudioInputs();
  const [result, setResult] = useState<TestResult | null>(null);
  const recorder = useVoiceRecorder({
    maxSeconds: TEST_MAX_SECONDS,
    onMicrophoneAccess: () => void refresh(),
    onComplete: async ({ blob }) => {
      setResult({ kind: "transcribing" });
      try {
        const audio = await blobToAudioPayload(blob, shouldPreferWav(value), wavSampleRate(value));
        const response = await voiceService.transcribe({
          audioBase64: audio.audioBase64,
          mimeType: audio.mimeType || blob.type || "audio/webm",
          language: value.language,
          enableItn: value.enableItn,
          settingsOverride: { ...value, enabled: true },
        });
        setResult({ kind: "text", text: finalizeTranscript(response.text, value) });
      } catch (error) {
        setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  const desktop = isTauriRuntime();
  const recording = recorder.phase !== "idle";
  const transcribing = result?.kind === "transcribing";

  const control = recording ? (
    <button type="button" className={VOICE_BUTTON_CLASS} style={VOICE_BUTTON_STYLE} disabled={recorder.phase !== "recording"} onClick={recorder.stop}>
      <Square aria-hidden="true" />
      {t("voiceStop")}
    </button>
  ) : (
    <button
      type="button"
      className={VOICE_BUTTON_CLASS}
      style={VOICE_BUTTON_STYLE}
      disabled={Boolean(blockedReason) || !desktop || transcribing}
      onClick={() => {
        setResult(null);
        const order = effectiveMicrophoneOrder(value.microphones, devices);
        void recorder.start(preferredMicrophoneId(order, devices));
      }}
    >
      {transcribing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Mic aria-hidden="true" />}
      {t("voiceTestTranscription")}
    </button>
  );

  let panel = null;
  if (recorder.error) {
    panel = <p role="alert" className="m-0 min-w-0 flex-1 text-[length:var(--text-small)]" style={{ color: "var(--app-status-danger)" }}>{t(RECORDER_ERROR_KEYS[recorder.error])}</p>;
  } else if (recorder.phase === "recording") {
    panel = (
      <>
        <RecordingDot />
        <VoiceLevelBars level={recorder.level} />
        <span className="min-w-0 truncate text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>{t("voiceTestSaySomething")}</span>
        <span className="ms-auto shrink-0 text-[length:var(--text-small)] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>{formatClock(recorder.elapsed)}</span>
      </>
    );
  } else if (result?.kind === "transcribing") {
    panel = <span role="status" className="text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>{t("voiceTestTranscribing")}</span>;
  } else if (result?.kind === "text") {
    panel = (
      <p role="status" aria-label={t("voiceTestResult")} className="m-0 min-w-0 flex-1 select-text whitespace-pre-wrap break-words py-1.5 text-[length:var(--text-row)] leading-relaxed" style={{ color: result.text ? "var(--app-text-primary)" : "var(--app-text-tertiary)" }}>
        {result.text || t("voiceTestNoSpeech")}
      </p>
    );
  } else if (result?.kind === "error") {
    panel = <p role="alert" className="m-0 min-w-0 flex-1 break-words py-1.5 text-[length:var(--text-small)]" style={{ color: "var(--app-status-danger)" }}>{result.message}</p>;
  }

  return (
    <VoiceRow
      title={t("voiceTestTitle")}
      description={!desktop ? t("voiceTestDesktopOnly") : blockedReason ?? t("voiceTestDesc")}
      control={control}
    >
      {panel ? (
        <VoiceInlinePanel
          closeLabel={t("voiceTestClose")}
          onClose={() => {
            recorder.cancel();
            recorder.clearError();
            setResult(null);
          }}
        >
          {panel}
        </VoiceInlinePanel>
      ) : null}
    </VoiceRow>
  );
}
