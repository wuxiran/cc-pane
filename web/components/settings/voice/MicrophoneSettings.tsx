// 「输入」分组：麦克风优先级列表 + 麦克风测试（录 10 秒本地回放，音频不出本机）。
import { useCallback, useEffect, useRef, useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, Mic, Pause, Play, RefreshCw, RotateCcw, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_MICROPHONE_ID,
  devicesKnown,
  effectiveMicrophoneOrder,
  forgetMicrophone,
  listAudioInputs,
  moveMicrophone,
  preferredMicrophoneId,
  type AudioInputDevice,
} from "@/lib/voiceMicrophones";
import type { VoiceMicrophone } from "@/types";
import { formatClock, useVoiceRecorder, type RecorderErrorKind } from "./useVoiceRecorder";
import {
  RecordingDot,
  VoiceInlinePanel,
  VoiceLevelBars,
  VoiceRow,
  VOICE_BUTTON_CLASS,
  VOICE_BUTTON_STYLE,
  VOICE_ICON_BUTTON_CLASS,
} from "./VoiceSettingsLayout";

const LOOPBACK_SECONDS = 10;

export const RECORDER_ERROR_KEYS: Record<RecorderErrorKind, "voiceMicUnsupported" | "voiceMicDenied" | "voiceMicNotFound" | "voiceMicEmpty" | "voiceMicFailed"> = {
  unsupported: "voiceMicUnsupported",
  denied: "voiceMicDenied",
  notFound: "voiceMicNotFound",
  empty: "voiceMicEmpty",
  failed: "voiceMicFailed",
};

/** 设备列表 + devicechange 订阅；授权后标签才可读，所以录音拿到权限时要再刷新一次。 */
export function useAudioInputs() {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const refresh = useCallback(async () => {
    try {
      setDevices(await listAudioInputs());
    } catch {
      setDevices([]);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onChange = () => void refresh();
    mediaDevices.addEventListener("devicechange", onChange);
    return () => mediaDevices.removeEventListener("devicechange", onChange);
  }, [refresh]);
  return { devices, refresh };
}

export default function MicrophoneSettings({
  saved,
  onChange,
}: {
  saved: VoiceMicrophone[] | undefined;
  onChange: (next: VoiceMicrophone[]) => void;
}) {
  const { t } = useTranslation("settings");
  const { devices, refresh } = useAudioInputs();
  const order = effectiveMicrophoneOrder(saved, devices);
  const preferred = preferredMicrophoneId(order, devices);
  const inUse = preferred ?? DEFAULT_MICROPHONE_ID;
  const known = devicesKnown(devices);

  return (
    <>
      <VoiceRow
        title={t("voiceMicrophone")}
        description={t("voiceMicrophoneDesc")}
        control={
          <button
            type="button"
            className={VOICE_ICON_BUTTON_CLASS}
            style={{ color: "var(--app-text-secondary)" }}
            aria-label={t("voiceRefreshMicrophones")}
            title={t("voiceRefreshMicrophones")}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        }
      >
        <MicrophoneOrderList
          order={order}
          inUse={inUse}
          isConnected={(id) => id === DEFAULT_MICROPHONE_ID || !known || devices.some((device) => device.deviceId === id)}
          onChange={onChange}
        />
      </VoiceRow>
      <MicrophoneTest key={inUse} deviceId={preferred} onMicrophoneAccess={() => void refresh()} />
    </>
  );
}

function MicrophoneOrderList({
  order,
  inUse,
  isConnected,
  onChange,
}: {
  order: VoiceMicrophone[];
  inUse: string;
  isConnected: (deviceId: string) => boolean;
  onChange: (next: VoiceMicrophone[]) => void;
}) {
  const { t } = useTranslation("settings");
  const ids = order.map((entry) => entry.deviceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const from = ids.indexOf(String(event.active.id));
    const to = ids.indexOf(String(event.over.id));
    if (from !== -1 && to !== -1) onChange(moveMicrophone(order, String(event.active.id), to - from));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol
          aria-label={t("voiceMicrophoneOrder")}
          className="mt-3 flex flex-col divide-y divide-[var(--app-border)] rounded-lg border"
          style={{ borderColor: "var(--app-border)" }}
        >
          {order.map((entry, index) => {
            const isDefault = entry.deviceId === DEFAULT_MICROPHONE_ID;
            const name = isDefault ? t("voiceMicrophoneSystemDefault") : entry.label || t("voiceMicrophoneUnnamed");
            return (
              <MicrophoneRow
                key={entry.deviceId}
                id={entry.deviceId}
                name={name}
                position={index + 1}
                count={order.length}
                inUse={entry.deviceId === inUse}
                connected={isConnected(entry.deviceId)}
                onMove={(steps) => onChange(moveMicrophone(order, entry.deviceId, steps))}
                onForget={isDefault ? undefined : () => onChange(forgetMicrophone(order, entry.deviceId))}
              />
            );
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function MicrophoneRow(props: {
  id: string;
  name: string;
  position: number;
  count: number;
  inUse: boolean;
  connected: boolean;
  onMove: (steps: number) => void;
  onForget?: () => void;
}) {
  const { t } = useTranslation("settings");
  const { name } = props;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: props.id });
  return (
    <li
      ref={setNodeRef}
      data-microphone={props.id}
      style={{ transform: CSS.Translate.toString(transform), transition, background: isDragging ? "var(--app-content)" : undefined }}
      className={`flex items-center gap-2 py-1.5 pe-1.5 ps-3 ${isDragging ? "relative z-10 rounded-lg shadow-md" : ""}`}
    >
      <span className="w-4 text-[length:var(--text-micro)] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>
        {props.position}
      </span>
      <span className="min-w-0 truncate text-[length:var(--text-row)]" style={{ color: props.connected ? "var(--app-text-primary)" : "var(--app-text-tertiary)" }}>
        {name}
      </span>
      {props.inUse ? (
        <span
          className="shrink-0 rounded px-1.5 text-[length:var(--text-micro)] font-medium"
          style={{ color: "var(--app-status-success)", background: "color-mix(in srgb, var(--app-status-success) 14%, transparent)" }}
        >
          {t("voiceMicrophoneInUse")}
        </span>
      ) : !props.connected ? (
        <span className="shrink-0 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("voiceMicrophoneNotConnected")}
        </span>
      ) : null}
      <span className="ms-auto flex items-center gap-0.5" style={{ color: "var(--app-text-tertiary)" }}>
        <span
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={t("voiceMicrophoneDrag", { name })}
          className="flex size-7 cursor-grab touch-none items-center justify-center rounded-md hover:text-[var(--app-text-primary)] active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" aria-hidden="true" />
        </span>
        <button type="button" className={VOICE_ICON_BUTTON_CLASS} disabled={props.position === 1} aria-label={t("voiceMicrophoneMoveUp", { name })} onClick={() => props.onMove(-1)}>
          <ArrowUp aria-hidden="true" />
        </button>
        <button type="button" className={VOICE_ICON_BUTTON_CLASS} disabled={props.position === props.count} aria-label={t("voiceMicrophoneMoveDown", { name })} onClick={() => props.onMove(1)}>
          <ArrowDown aria-hidden="true" />
        </button>
        {props.onForget ? (
          <button type="button" className={VOICE_ICON_BUTTON_CLASS} aria-label={t("voiceMicrophoneForget", { name })} onClick={props.onForget}>
            <X aria-hidden="true" />
          </button>
        ) : (
          <span aria-hidden="true" className="size-7" />
        )}
      </span>
    </li>
  );
}

function MicrophoneTest({ deviceId, onMicrophoneAccess }: { deviceId: string | null; onMicrophoneAccess: () => void }) {
  const { t } = useTranslation("settings");
  const [recording, setRecording] = useState<{ url: string; duration: number } | null>(null);
  const urlRef = useRef<string | null>(null);
  const discard = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setRecording(null);
  }, []);
  useEffect(() => discard, [discard]);
  const recorder = useVoiceRecorder({
    maxSeconds: LOOPBACK_SECONDS,
    onMicrophoneAccess,
    onComplete: ({ blob, duration }) => {
      discard();
      urlRef.current = URL.createObjectURL(blob);
      setRecording({ url: urlRef.current, duration });
    },
  });
  const busy = recorder.phase !== "idle";

  const control = busy ? (
    <button type="button" className={VOICE_BUTTON_CLASS} style={VOICE_BUTTON_STYLE} disabled={recorder.phase !== "recording"} onClick={recorder.stop}>
      <Square aria-hidden="true" />
      {t("voiceStop")}
    </button>
  ) : (
    <button
      type="button"
      className={VOICE_BUTTON_CLASS}
      style={VOICE_BUTTON_STYLE}
      onClick={() => {
        discard();
        void recorder.start(deviceId);
      }}
    >
      {recording ? <RotateCcw aria-hidden="true" /> : <Mic aria-hidden="true" />}
      {recording ? t("voiceRecordAgain") : t("voiceRecord")}
    </button>
  );

  const close = () => {
    recorder.cancel();
    recorder.clearError();
    discard();
  };

  let panel = null;
  if (recorder.error) {
    panel = (
      <p role="alert" className="m-0 min-w-0 flex-1 text-[length:var(--text-small)]" style={{ color: "var(--app-status-danger)" }}>
        {t(RECORDER_ERROR_KEYS[recorder.error])}
      </p>
    );
  } else if (recorder.phase === "starting") {
    panel = <span role="status" className="text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>{t("voiceOpeningMicrophone")}</span>;
  } else if (recorder.phase === "recording") {
    panel = (
      <>
        <RecordingDot />
        <VoiceLevelBars level={recorder.level} />
        <span className="ms-auto text-[length:var(--text-small)] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>
          {formatClock(recorder.elapsed)} / {formatClock(LOOPBACK_SECONDS)}
        </span>
      </>
    );
  } else if (recording) {
    panel = <MicrophonePlayback key={recording.url} src={recording.url} duration={recording.duration} />;
  }

  return (
    <VoiceRow title={t("voiceMicrophoneTest")} description={t("voiceMicrophoneTestDesc")} control={control}>
      {panel ? (
        <VoiceInlinePanel onClose={close} closeLabel={t("voiceDiscardRecording")}>
          {panel}
        </VoiceInlinePanel>
      ) : null}
    </VoiceRow>
  );
}

function MicrophonePlayback({ src, duration }: { src: string; duration: number }) {
  const { t } = useTranslation("settings");
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [failed, setFailed] = useState(false);
  const progress = duration > 0 ? Math.min(position / duration, 1) * 100 : 0;
  const toggle = async () => {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) {
      player.pause();
      return;
    }
    setFailed(false);
    if (player.ended) player.currentTime = 0;
    try {
      await player.play();
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        className="-ms-2 flex size-7 shrink-0 items-center justify-center rounded-full border hover:bg-[var(--app-active-bg)] [&_svg]:size-3"
        style={VOICE_BUTTON_STYLE}
        aria-label={playing ? t("voicePausePlayback") : t("voicePlayRecording")}
        onClick={() => void toggle()}
      >
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </button>
      {failed ? (
        <p role="alert" className="m-0 min-w-0 flex-1 text-[length:var(--text-small)]" style={{ color: "var(--app-status-danger)" }}>
          {t("voicePlaybackFailed")}
        </p>
      ) : (
        <input
          type="range"
          aria-label={t("voicePlaybackPosition")}
          min={0}
          max={duration}
          step={0.01}
          value={Math.min(position, duration)}
          disabled={duration <= 0}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (audio.current) audio.current.currentTime = next;
            setPosition(next);
          }}
          className="h-1 min-w-0 flex-1 appearance-none rounded-full [&::-webkit-slider-thumb]:size-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--app-accent)]"
          style={{ background: `linear-gradient(to right, var(--app-accent) ${progress}%, var(--app-border) ${progress}%)` }}
        />
      )}
      <span className="shrink-0 text-[length:var(--text-small)] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>
        {formatClock(position)} / {formatClock(duration)}
      </span>
    </>
  );
}
