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

interface RecordingAttempt {
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  timer: number | null;
}

function releaseRecording(attempt: RecordingAttempt, discard = false): void {
  if (attempt.timer !== null) window.clearTimeout(attempt.timer);
  attempt.timer = null;
  if (discard && attempt.recorder) {
    attempt.recorder.onstop = null;
    attempt.recorder.ondataavailable = null;
    attempt.recorder.onerror = null;
    if (attempt.recorder.state !== "inactive") attempt.recorder.stop();
  }
  attempt.stream?.getTracks().forEach((track) => track.stop());
  attempt.stream = null;
  if (discard) attempt.chunks = [];
}

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
  const setActiveTarget = useVoiceInputStore((state) => state.setActiveTarget);
  const clearActiveTarget = useVoiceInputStore((state) => state.clearActiveTarget);

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const attemptRef = useRef<RecordingAttempt | null>(null);
  const mountedRef = useRef(true);
  const targetId = `agent-chat:${chatId}`;
  const isCurrent = useCallback((attempt: RecordingAttempt) => mountedRef.current && attemptRef.current === attempt, []);

  const cancelAttempt = useCallback(() => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    attemptRef.current = null;
    releaseRecording(attempt, true);
    if (mountedRef.current) setStatus("idle");
    clearActiveTarget(targetId);
  }, [clearActiveTarget, targetId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAttempt();
    };
  }, [cancelAttempt]);

  const unavailableReason = useCallback((): string | null => {
    if (!isTauriRuntime()) return t("voiceUnavailable");
    if (!voice?.enabled) return t("voiceEnableInSettings");
    if (missingApiKey(voice)) return t("voiceApiKeyMissing");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return t("voiceRecorderUnsupported");
    }
    const active = useVoiceInputStore.getState().activeTargetId;
    if (active !== null && active !== targetId) return t("voiceBusyElsewhere");
    return null;
  }, [t, targetId, voice]);

  const finish = useCallback(
    async (attempt: RecordingAttempt, mimeType: string) => {
      if (!isCurrent(attempt)) { releaseRecording(attempt, true); return; }
      setStatus("transcribing");
      releaseRecording(attempt);
      try {
        const blob = new Blob(attempt.chunks, { type: mimeType || "audio/webm" });
        attempt.chunks = [];
        if (blob.size === 0) throw new Error(t("voiceEmptyAudio"));
        const audio = await blobToAudioPayload(blob, voice ? shouldPreferWav(voice) : false);
        if (!isCurrent(attempt)) return;
        const result = await voiceService.transcribe({
          audioBase64: audio.audioBase64,
          mimeType: audio.mimeType || blob.type || mimeType || "audio/webm",
          language: voice?.language ?? null,
          enableItn: voice?.enableItn ?? false,
        });
        if (!isCurrent(attempt)) return;
        const text = result.text.trim();
        if (!text) throw new Error(t("voiceEmptyTranscript"));
        onText(text);
      } catch (error) {
        if (isCurrent(attempt)) toastErr(t("voiceFailed", { error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (isCurrent(attempt)) {
          attemptRef.current = null;
          setStatus("idle");
          clearActiveTarget(targetId);
        }
      }
    },
    [clearActiveTarget, isCurrent, onText, t, targetId, voice],
  );

  const stopRecording = useCallback(() => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    // 停止也能撤销尚未返回的系统授权；迟到的流由 startRecording 立即释放。
    if (!attempt.recorder) { cancelAttempt(); return; }
    if (attempt.recorder.state === "inactive") return;
    setStatus("transcribing");
    attempt.recorder.stop();
  }, [cancelAttempt]);

  const startRecording = useCallback(async () => {
    if (attemptRef.current) return;
    const reason = unavailableReason();
    if (reason) { toastErr(reason); return; }
    const attempt: RecordingAttempt = { stream: null, recorder: null, chunks: [], timer: null };
    attemptRef.current = attempt;
    setActiveTarget(targetId);
    setStatus("recording");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent(attempt)) { stream.getTracks().forEach((track) => track.stop()); return; }
      attempt.stream = stream;
      const mimeType = getRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      attempt.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (isCurrent(attempt) && event.data.size > 0) attempt.chunks.push(event.data);
      };
      recorder.onstop = () => { void finish(attempt, recorder.mimeType || mimeType || "audio/webm"); };
      recorder.onerror = () => {
        if (!isCurrent(attempt)) return;
        cancelAttempt();
        toastErr(t("voiceFailed", { error: "MediaRecorder error" }));
      };
      recorder.start();
      const maxSeconds = Math.min(Math.max(voice?.maxRecordSeconds || 60, 1), 300);
      attempt.timer = window.setTimeout(() => { if (isCurrent(attempt)) stopRecording(); }, maxSeconds * 1000);
    } catch (error) {
      if (!isCurrent(attempt)) return;
      cancelAttempt();
      toastErr(t("voiceFailed", { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [cancelAttempt, finish, isCurrent, setActiveTarget, stopRecording, t, targetId, unavailableReason, voice]);

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
