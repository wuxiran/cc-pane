import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Loader2, Mic, MicOff, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { terminalService, voiceService } from "@/services";
import { useSettingsStore, useVoiceInputStore } from "@/stores";
import { cn } from "@/lib/utils";

type VoiceStatus = "idle" | "recording" | "transcribing";
type VoiceButtonPosition = { right: number; bottom: number };

interface VoiceInputButtonProps {
  sessionId: string | null;
  paneId: string;
  disabled?: boolean;
}

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];
const MIMO_SUPPORTED_MIME_TYPES = new Set([
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/flac",
]);
const BUTTON_SIZE = 48;
const BUTTON_PADDING = 12;

type AudioPayload = {
  audioBase64: string;
  mimeType: string;
};

type WebAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

function getRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return undefined;
  }
  return MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio blob"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const [, base64 = ""] = result.split(",", 2);
      resolve(base64);
    };
    reader.readAsDataURL(blob);
  });
}

async function blobToAudioPayload(blob: Blob, preferWav: boolean): Promise<AudioPayload> {
  if (!preferWav) {
    return {
      audioBase64: await blobToBase64(blob),
      mimeType: blob.type || "audio/webm",
    };
  }

  try {
    const wavBlob = await transcodeBlobToMonoWav(blob);
    return {
      audioBase64: await blobToBase64(wavBlob),
      mimeType: "audio/wav",
    };
  } catch {
    if (isMimoSupportedMimeType(blob.type)) {
      return {
        audioBase64: await blobToBase64(blob),
        mimeType: blob.type,
      };
    }
    throw new Error("Xiaomi MiMo requires WAV/MP3/M4A/OGG/FLAC audio; local WAV conversion failed.");
  }
}

function isMimoSupportedMimeType(mimeType: string): boolean {
  const baseType = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIMO_SUPPORTED_MIME_TYPES.has(baseType);
}

async function transcodeBlobToMonoWav(blob: Blob): Promise<Blob> {
  const AudioContextCtor = window.AudioContext ?? (window as WebAudioWindow).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("AudioContext is unavailable");
  }

  const audioContext = new AudioContextCtor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    return encodeMonoWav(audioBuffer);
  } finally {
    void audioContext.close();
  }
}

function encodeMonoWav(audioBuffer: AudioBuffer): Blob {
  const sampleRate = audioBuffer.sampleRate;
  const sampleCount = audioBuffer.length;
  const channelCount = audioBuffer.numberOfChannels;
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: channelCount }, (_, index) => audioBuffer.getChannelData(index));
  let offset = 44;
  for (let index = 0; index < sampleCount; index += 1) {
    let sample = 0;
    for (const channel of channels) {
      sample += channel[index] ?? 0;
    }
    sample = Math.max(-1, Math.min(1, sample / Math.max(channelCount, 1)));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

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
    if (!sessionId) return t("voiceNoSession");
    if (disabled) return t("voiceUnavailable");
    if (!voice?.enabled) return t("voiceEnableInSettings");
    if (voice.provider === "mimo") {
      if (!voice.mimoApiKey.trim()) return t("voiceApiKeyMissing");
    } else if (!voice.dashscopeApiKey.trim()) {
      return t("voiceApiKeyMissing");
    }
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
        const audio = await blobToAudioPayload(blob, voice?.provider === "mimo");
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
              ? "border-red-300/70 bg-red-500 text-white shadow-[0_0_0_5px_rgba(239,68,68,0.18),0_14px_34px_rgba(127,29,29,0.32)]"
              : status === "transcribing"
                ? "border-sky-300/70 bg-sky-500 text-white shadow-[0_0_0_5px_rgba(14,165,233,0.16),0_14px_34px_rgba(12,74,110,0.28)]"
                : voice?.enabled
                  ? "border-blue-300/70 bg-blue-600 text-white shadow-[0_0_0_4px_rgba(37,99,235,0.16),0_14px_34px_rgba(15,23,42,0.36)] hover:scale-105 hover:bg-blue-500"
                  : "border-white/20 bg-slate-700 text-white/70 shadow-[0_14px_34px_rgba(15,23,42,0.28)] backdrop-blur hover:border-white/35 hover:text-white"
          )}
          style={{ right: position.right, bottom: position.bottom }}
        >
          <Icon className={cn("h-5 w-5", status === "transcribing" && "animate-spin")} />
          {status === "recording" ? (
            <span className="pointer-events-none absolute inset-0 rounded-full border border-red-200/70 animate-ping" />
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        {unavailableReason && !active ? unavailableReason : label}
      </TooltipContent>
    </Tooltip>
  );
}
