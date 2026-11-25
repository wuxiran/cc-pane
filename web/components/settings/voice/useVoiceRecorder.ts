// 设置页的录音小工具：麦克风测试与试转写共用。带电平（AnalyserNode）与计时，
// 到时自动停止；组件卸载时释放麦克风。录音入口（终端 / agent-chat）不走这里。
import { useCallback, useEffect, useRef, useState } from "react";
import { getRecorderMimeType } from "@/lib/voiceAudio";
import { openMicrophone } from "@/lib/voiceMicrophones";

export type RecorderPhase = "idle" | "starting" | "recording";

export type RecorderErrorKind = "unsupported" | "denied" | "notFound" | "empty" | "failed";

interface Capture {
  stream?: MediaStream;
  recorder?: MediaRecorder;
  context?: AudioContext;
  frame?: number;
  timer?: ReturnType<typeof setTimeout>;
  ticker?: ReturnType<typeof setInterval>;
  startedAt?: number;
}

type WebAudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

function errorKind(error: unknown): RecorderErrorKind {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError") return "notFound";
  return "failed";
}

export function useVoiceRecorder(options: {
  maxSeconds: number;
  onComplete: (recording: { blob: Blob; duration: number }) => void;
  onMicrophoneAccess?: () => void;
}) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<RecorderErrorKind | null>(null);
  const capture = useRef<Capture | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const release = useCallback(() => {
    const current = capture.current;
    if (!current) return;
    capture.current = null;
    clearTimeout(current.timer);
    clearInterval(current.ticker);
    if (current.frame !== undefined) cancelAnimationFrame(current.frame);
    if (current.recorder && current.recorder.state !== "inactive") {
      current.recorder.ondataavailable = null;
      current.recorder.onstop = null;
      current.recorder.stop();
    }
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context?.close().catch(() => undefined);
  }, []);

  useEffect(() => release, [release]);

  const cancel = useCallback(() => {
    release();
    setLevel(0);
    setPhase("idle");
  }, [release]);

  const stop = useCallback(() => {
    const recorder = capture.current?.recorder;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const start = useCallback(async (deviceId: string | null) => {
    release();
    setError(null);
    setLevel(0);
    setElapsed(0);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("unsupported");
      return;
    }
    const current: Capture = {};
    capture.current = current;
    setPhase("starting");
    try {
      const stream = await openMicrophone(deviceId);
      if (capture.current !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      optionsRef.current.onMicrophoneAccess?.();

      const mimeType = getRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      current.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (capture.current !== current) return;
        const duration = current.startedAt === undefined ? 0 : (performance.now() - current.startedAt) / 1000;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        release();
        setLevel(0);
        setPhase("idle");
        if (blob.size === 0) {
          setError("empty");
          return;
        }
        optionsRef.current.onComplete({ blob, duration });
      };

      const AudioContextCtor = window.AudioContext ?? (window as WebAudioWindow).webkitAudioContext;
      if (AudioContextCtor) {
        const context = new AudioContextCtor();
        current.context = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        const tick = () => {
          if (capture.current !== current) return;
          analyser.getByteTimeDomainData(samples);
          let peak = 0;
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128) / 128);
          setLevel(Math.min(1, peak * 1.6));
          current.frame = requestAnimationFrame(tick);
        };
        current.frame = requestAnimationFrame(tick);
      }

      const startedAt = performance.now();
      current.startedAt = startedAt;
      const maxSeconds = optionsRef.current.maxSeconds;
      current.ticker = setInterval(() => {
        setElapsed(Math.min(maxSeconds, Math.floor((performance.now() - startedAt) / 1000)));
      }, 200);
      current.timer = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, maxSeconds * 1000);
      recorder.start();
      setPhase("recording");
    } catch (cause) {
      if (capture.current !== current) return;
      release();
      setPhase("idle");
      setError(errorKind(cause));
    }
  }, [release]);

  return { phase, level, elapsed, error, start, stop, cancel, clearError: () => setError(null) };
}

export const formatClock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
