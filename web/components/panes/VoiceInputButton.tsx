import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Loader2, Mic, MicOff, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { terminalService, voiceService } from "@/services";
import { useSettingsStore, useVoiceInputStore } from "@/stores";
import { cn } from "@/lib/utils";
import { missingApiKey, shouldPreferWav } from "@/lib/voiceProviders";
import { blobToAudioPayload, getRecorderMimeType } from "@/lib/voiceAudio";
import { isTauriRuntime } from "@/services/runtime";

type VoiceStatus = "idle" | "recording" | "transcribing";
type VoiceButtonPosition = { right: number; bottom: number };

interface VoiceInputButtonProps {
  sessionId: string | null;
  paneId: string;
  disabled?: boolean;
}

const BUTTON_SIZE = 48;
const BUTTON_PADDING = 12;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function mediaRecorderErrorMessage(event: Event): string {
  const error = (event as Event & { error?: DOMException }).error;
  return error?.message ?? "MediaRecorder error";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export default function VoiceInputButton({ sessionId, paneId, disabled = false }: VoiceInputButtonProps) {
  const { t } = useTranslation("panes");
  const voice = useSettingsStore((s) => s.settings?.voice);
  // 设置里关掉悬浮按钮则完全不渲染（settings 未加载时按默认显示）
  const hidden = voice ? voice.showFloatingButton === false : false;
  const activeTargetId = useVoiceInputStore((s) => s.activeTargetId);
  const toggleRequest = useVoiceInputStore((s) => s.toggleRequest);
  const setActiveTarget = useVoiceInputStore((s) => s.setActiveTarget);
  const clearActiveTarget = useVoiceInputStore((s) => s.clearActiveTarget);

  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [position, setPosition] = useState<VoiceButtonPosition>({
    right: 16,
    bottom: 16,
  });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const cancelledRef = useRef(false);
  const dragMovedRef = useRef(false);
  const handledRequestSeqRef = useRef(0);

  const targetId = `${paneId}:${sessionId ?? "empty"}`;
  const isActiveTarget = activeTargetId === targetId;
  const isBusyElsewhere = activeTargetId !== null && !isActiveTarget;

  const clampPosition = useCallback((next: VoiceButtonPosition): VoiceButtonPosition => {
    const parent = buttonRef.current?.parentElement;
    if (!parent) return next;
    const rect = parent.getBoundingClientRect();
    const maxRight = rect.width - BUTTON_SIZE - BUTTON_PADDING;
    const maxBottom = rect.height - BUTTON_SIZE - BUTTON_PADDING;
    return {
      right: clamp(next.right, BUTTON_PADDING, maxRight),
      bottom: clamp(next.bottom, BUTTON_PADDING, maxBottom),
    };
  }, []);

  const unavailableReason = useMemo(() => {
    if (!isTauriRuntime()) return t("voiceUnavailable");
    if (!sessionId) return t("voiceNoSession");
    if (disabled) return t("voiceUnavailable");
    if (!voice?.enabled) return t("voiceEnableInSettings");
    if (missingApiKey(voice)) return t("voiceApiKeyMissing");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return t("voiceRecorderUnsupported");
    }
    if (isBusyElsewhere) return t("voiceBusyElsewhere");
    return null;
  }, [disabled, isBusyElsewhere, sessionId, t, voice]);

  const cleanupRecorder = useCallback(() => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const safeSetStatus = useCallback((next: VoiceStatus) => {
    if (mountedRef.current) setStatus(next);
  }, []);

  const finishRecording = useCallback(
    async (mimeType: string) => {
      if (cancelledRef.current) {
        chunksRef.current = [];
        cleanupRecorder();
        clearActiveTarget(targetId);
        return;
      }
      safeSetStatus("transcribing");
      cleanupRecorder();
      try {
        const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) {
          throw new Error(t("voiceEmptyAudio"));
        }
        const audio = await blobToAudioPayload(blob, voice ? shouldPreferWav(voice) : false);
        const result = await voiceService.transcribe({
          audioBase64: audio.audioBase64,
          mimeType: audio.mimeType || blob.type || mimeType || "audio/webm",
          language: voice?.language ?? null,
          enableItn: voice?.enableItn ?? false,
        });
        const text = result.text.trim();
        if (!text) {
          throw new Error(t("voiceEmptyTranscript"));
        }
        await terminalService.write(sessionId!, text);
        toast.success(t("voiceInserted"));
      } catch (error) {
        toast.error(t("voiceFailed", { error: errorMessage(error) }));
      } finally {
        safeSetStatus("idle");
        clearActiveTarget(targetId);
      }
    },
    [cleanupRecorder, clearActiveTarget, safeSetStatus, sessionId, t, targetId, voice]
  );

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    safeSetStatus("transcribing");
    recorder.stop();
  }, [safeSetStatus]);

  const startRecording = useCallback(async () => {
    if (unavailableReason) {
      toast.error(unavailableReason);
      return;
    }
    if (!sessionId || !voice) return;

    setActiveTarget(targetId);
    safeSetStatus("recording");
    cancelledRef.current = false;
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = getRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        void finishRecording(recorder.mimeType || mimeType || "audio/webm");
      };
      recorder.onerror = (event) => {
        cleanupRecorder();
        safeSetStatus("idle");
        clearActiveTarget(targetId);
        toast.error(t("voiceFailed", { error: mediaRecorderErrorMessage(event) }));
      };

      recorder.start();
      const maxSeconds = Math.min(Math.max(voice.maxRecordSeconds || 60, 1), 300);
      stopTimerRef.current = window.setTimeout(stopRecording, maxSeconds * 1000);
    } catch (error) {
      cleanupRecorder();
      safeSetStatus("idle");
      clearActiveTarget(targetId);
      toast.error(t("voiceFailed", { error: errorMessage(error) }));
    }
  }, [
    cleanupRecorder,
    clearActiveTarget,
    finishRecording,
    safeSetStatus,
    sessionId,
    setActiveTarget,
    stopRecording,
    t,
    targetId,
    unavailableReason,
    voice,
  ]);

  const toggleRecording = useCallback(() => {
    if (status === "transcribing") return;
    if (status === "recording") {
      stopRecording();
      return;
    }
    void startRecording();
  }, [startRecording, status, stopRecording]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const button = buttonRef.current;
      const parent = button?.parentElement;
      if (!button || !parent) return;

      const parentRect = parent.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      dragMovedRef.current = false;
      button.setPointerCapture(event.pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (Math.abs(deltaX) + Math.abs(deltaY) > 4) {
          dragMovedRef.current = true;
        }
        const nextRight = parentRect.right - moveEvent.clientX - buttonRect.width / 2;
        const nextBottom = parentRect.bottom - moveEvent.clientY - buttonRect.height / 2;
        setPosition(clampPosition({ right: nextRight, bottom: nextBottom }));
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (button.hasPointerCapture(upEvent.pointerId)) {
          button.releasePointerCapture(upEvent.pointerId);
        }
        button.removeEventListener("pointermove", handlePointerMove);
        button.removeEventListener("pointerup", handlePointerUp);
        button.removeEventListener("pointercancel", handlePointerUp);
      };

      button.addEventListener("pointermove", handlePointerMove);
      button.addEventListener("pointerup", handlePointerUp);
      button.addEventListener("pointercancel", handlePointerUp);
    },
    [clampPosition]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      cleanupRecorder();
      clearActiveTarget(targetId);
    };
  }, [cleanupRecorder, clearActiveTarget, targetId]);

  useEffect(() => {
    if (!toggleRequest || toggleRequest.targetId !== targetId) return;
    if (toggleRequest.seq === handledRequestSeqRef.current) return;
    handledRequestSeqRef.current = toggleRequest.seq;
    toggleRecording();
  }, [targetId, toggleRecording, toggleRequest]);

  useEffect(() => {
    const parent = buttonRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setPosition((current) => clampPosition(current));
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [clampPosition]);

  // hooks 全部执行完后再隐藏，避免违反 hooks 顺序规则
  if (hidden) return null;

  const active = status !== "idle" && isActiveTarget;
  const canInteract = !unavailableReason || active;
  const label = status === "recording"
    ? t("voiceStopRecording")
    : status === "transcribing"
      ? t("voiceTranscribing")
      : t("voiceStartRecording");
  const Icon = status === "recording" ? Square : status === "transcribing" ? Loader2 : voice?.enabled ? Mic : MicOff;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          ref={buttonRef}
          aria-label={label}
          aria-disabled={!canInteract || status === "transcribing"}
          onPointerDown={handlePointerDown}
          onClick={(event) => {
            event.stopPropagation();
            if (dragMovedRef.current) {
              dragMovedRef.current = false;
              return;
            }
            if (status === "transcribing") return;
            if (!canInteract) {
              if (unavailableReason) toast.error(unavailableReason);
              return;
            }
            toggleRecording();
          }}
          className={cn(
            "absolute z-[3] flex h-12 w-12 touch-none items-center justify-center rounded-full border transition-[background,border-color,box-shadow,color,opacity,transform]",
            "cursor-grab active:cursor-grabbing",
            (!canInteract || status === "transcribing") && "opacity-55",
            status === "recording"
              ? "border-[color-mix(in_srgb,var(--app-status-danger)_60%,transparent)] bg-[var(--app-status-danger)] text-white shadow-[0_0_0_5px_var(--app-status-danger-bg),0_14px_34px_var(--app-status-danger-border)]"
              : status === "transcribing"
                ? "border-[color-mix(in_srgb,var(--app-accent)_60%,transparent)] bg-[var(--app-accent)] text-white shadow-[0_0_0_5px_var(--app-active-bg),0_14px_34px_var(--app-border)]"
                : voice?.enabled
                  ? "border-[color-mix(in_srgb,var(--app-accent)_60%,transparent)] bg-[var(--app-accent)] text-white shadow-[0_0_0_4px_var(--app-active-bg),0_14px_34px_var(--app-border)] hover:scale-105 hover:bg-[color-mix(in_srgb,var(--app-accent)_85%,white)]"
                  : "border-[var(--app-border)] bg-[var(--muted)] text-[var(--app-text-secondary)] shadow-[0_14px_34px_var(--app-border)] backdrop-blur hover:border-[var(--app-border)] hover:text-[var(--app-text-primary)]"
          )}
          style={{ right: position.right, bottom: position.bottom }}
        >
          <Icon className={cn("h-5 w-5", status === "transcribing" && "animate-spin")} />
          {status === "recording" ? (
            <span className="pointer-events-none absolute inset-0 rounded-full border border-[color-mix(in_srgb,var(--app-status-danger)_45%,transparent)] animate-ping" />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {unavailableReason && !active ? unavailableReason : label}
      </TooltipContent>
    </Tooltip>
  );
}
