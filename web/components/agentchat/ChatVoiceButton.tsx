// agent-chat 的紧凑麦克风按钮：录音 → 转写 → 文本回调进草稿。
// 录音编排与终端悬浮麦克风（VoiceInputButton）平行实现，音频封装共用
// lib/voiceAudio；经 useVoiceInputStore 与其他录音入口互斥。
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toastErr } from "@/lib/feedback";
import { voiceService } from "@/services";
import { useSettingsStore, useVoiceInputStore } from "@/stores";
import { blobToAudioPayload, getRecorderMimeType } from "@/lib/voiceAudio";
import { missingApiKey, shouldPreferWav } from "@/lib/voiceProviders";
import { isTauriRuntime } from "@/services/runtime";

type VoiceStatus = "idle" | "recording" | "transcribing";

export interface ChatVoiceButtonProps {
  chatId: string;
  onText: (text: string) => void;
  /** 尺寸覆盖（默认 h-7 w-7）。 */
  sizeClass?: string;
  /** outline = 描边按钮；ghost = 无边框图标（composer 工具栏用）。 */
  variant?: "outline" | "ghost";
}

export default function ChatVoiceButton({
  chatId,
  onText,
  sizeClass = "h-7 w-7",
  variant = "outline",
}: ChatVoiceButtonProps) {
  const { t } = useTranslation("panes");
  const voice = useSettingsStore((state) => state.settings?.voice);
  const activeTargetId = useVoiceInputStore((state) => state.activeTargetId);
  const setActiveTarget = useVoiceInputStore((state) => state.setActiveTarget);
  const clearActiveTarget = useVoiceInputStore((state) => state.clearActiveTarget);

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const targetId = `agent-chat:${chatId}`;
  const busyElsewhere = activeTargetId !== null && activeTargetId !== targetId;

  const cleanup = useCallback(() => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      cleanup();
      clearActiveTarget(targetId);
    };
  }, [cleanup, clearActiveTarget, targetId]);

  const unavailableReason = useCallback((): string | null => {
    if (!isTauriRuntime()) return t("voiceUnavailable");
    if (!voice?.enabled) return t("voiceEnableInSettings");
    if (missingApiKey(voice)) return t("voiceApiKeyMissing");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return t("voiceRecorderUnsupported");
    }
    if (busyElsewhere) return t("voiceBusyElsewhere");
    return null;
  }, [busyElsewhere, t, voice]);

  const finish = useCallback(
    async (mimeType: string) => {
      if (mountedRef.current) setStatus("transcribing");
      cleanup();
      try {
        const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) throw new Error(t("voiceEmptyAudio"));
        const audio = await blobToAudioPayload(blob, voice ? shouldPreferWav(voice) : false);
        const result = await voiceService.transcribe({
          audioBase64: audio.audioBase64,
          mimeType: audio.mimeType || blob.type || mimeType || "audio/webm",
          language: voice?.language ?? null,
          enableItn: voice?.enableItn ?? false,
        });
        const text = result.text.trim();
        if (!text) throw new Error(t("voiceEmptyTranscript"));
        onText(text);
      } catch (error) {
        toastErr(
          t("voiceFailed", { error: error instanceof Error ? error.message : String(error) }),
        );
      } finally {
        if (mountedRef.current) setStatus("idle");
        clearActiveTarget(targetId);
      }
    },
    [cleanup, clearActiveTarget, onText, t, targetId, voice],
  );

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    if (mountedRef.current) setStatus("transcribing");
    recorder.stop();
  }, []);

  const startRecording = useCallback(async () => {
    const reason = unavailableReason();
    if (reason) {
      toastErr(reason);
      return;
    }
    setActiveTarget(targetId);
    setStatus("recording");
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = getRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        void finish(recorder.mimeType || mimeType || "audio/webm");
      };
      recorder.onerror = () => {
        cleanup();
        if (mountedRef.current) setStatus("idle");
        clearActiveTarget(targetId);
        toastErr(t("voiceFailed", { error: "MediaRecorder error" }));
      };
      recorder.start();
      const maxSeconds = Math.min(Math.max(voice?.maxRecordSeconds || 60, 1), 300);
      stopTimerRef.current = window.setTimeout(stopRecording, maxSeconds * 1000);
    } catch (error) {
      cleanup();
      if (mountedRef.current) setStatus("idle");
      clearActiveTarget(targetId);
      toastErr(
        t("voiceFailed", { error: error instanceof Error ? error.message : String(error) }),
      );
    }
  }, [cleanup, clearActiveTarget, finish, setActiveTarget, stopRecording, t, targetId, unavailableReason, voice]);

  const label =
    status === "recording"
      ? t("voiceStopRecording")
      : status === "transcribing"
        ? t("voiceTranscribing")
        : t("voiceStartRecording");

  const idleClass =
    variant === "ghost"
      ? "border-transparent text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
      : "border-[var(--app-border)] text-[var(--app-icon-inactive)] hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={status === "transcribing"}
      className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-md border transition-colors ${
        status === "recording"
          ? "border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-bg)] text-[var(--app-status-danger)]"
          : idleClass
      } disabled:opacity-50`}
      onClick={() => {
        if (status === "transcribing") return;
        if (status === "recording") {
          stopRecording();
          return;
        }
        void startRecording();
      }}
    >
      {status === "recording" ? (
        <Square className="h-3 w-3" />
      ) : status === "transcribing" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Mic className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
