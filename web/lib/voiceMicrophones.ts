// 麦克风优先级：设置页列表与两个录音入口（终端悬浮麦克风、agent-chat 麦克风）共用。
// 录音用列表里第一个「可用」的条目：系统默认永远可用；具体设备要已连接。
import type { VoiceMicrophone, VoiceSettings } from "@/types";

export const DEFAULT_MICROPHONE_ID = "default";

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

/** Chromium/WebKit 给系统默认 / 通讯设备的别名条目，不当作独立设备列出。 */
const ALIAS_DEVICE_IDS = new Set(["default", "communications"]);

export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput" && !ALIAS_DEVICE_IDS.has(device.deviceId))
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

/** 授权前 deviceId 是空串，此时无法判断哪个设备已连接。 */
export function devicesKnown(devices: readonly AudioInputDevice[]): boolean {
  return devices.some((device) => device.deviceId);
}

/**
 * 实际展示与生效的顺序：已保存的条目在前（没保存过时只有「系统默认」），
 * 新接入、尚未排过序的设备追加在末尾。保证「系统默认」恰好出现一次。
 */
export function effectiveMicrophoneOrder(
  saved: readonly VoiceMicrophone[] | undefined,
  devices: readonly AudioInputDevice[],
): VoiceMicrophone[] {
  const order: VoiceMicrophone[] = [];
  const seen = new Set<string>();
  const push = (entry: VoiceMicrophone) => {
    if (!entry.deviceId || seen.has(entry.deviceId)) return;
    seen.add(entry.deviceId);
    order.push(entry);
  };
  for (const entry of saved ?? []) {
    const device = devices.find((candidate) => candidate.deviceId === entry.deviceId);
    // 授权后能拿到更准确的名字，顺手刷新
    push(device?.label ? { deviceId: entry.deviceId, label: device.label } : entry);
  }
  push({ deviceId: DEFAULT_MICROPHONE_ID, label: "" });
  for (const device of devices) {
    if (device.deviceId) push({ deviceId: device.deviceId, label: device.label });
  }
  return order;
}

/** 录音要用的 deviceId；null = 系统默认。 */
export function preferredMicrophoneId(
  order: readonly VoiceMicrophone[],
  devices: readonly AudioInputDevice[],
): string | null {
  const known = devicesKnown(devices);
  for (const entry of order) {
    if (entry.deviceId === DEFAULT_MICROPHONE_ID) return null;
    // 还没授权时不知道连没连，先按用户的首选试；打不开会回落到系统默认
    if (!known || devices.some((device) => device.deviceId === entry.deviceId)) return entry.deviceId;
  }
  return null;
}

export function moveMicrophone(order: readonly VoiceMicrophone[], deviceId: string, steps: number): VoiceMicrophone[] {
  const from = order.findIndex((entry) => entry.deviceId === deviceId);
  if (from === -1) return [...order];
  const to = Math.min(Math.max(from + steps, 0), order.length - 1);
  const next = [...order];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

export function forgetMicrophone(order: readonly VoiceMicrophone[], deviceId: string): VoiceMicrophone[] {
  if (deviceId === DEFAULT_MICROPHONE_ID) return [...order];
  return order.filter((entry) => entry.deviceId !== deviceId);
}

function isMissingDeviceError(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  return name === "OverconstrainedError" || name === "NotFoundError" || name === "NotReadableError";
}

/** 打开指定麦克风；指定设备不可用时回落到系统默认。 */
export async function openMicrophone(deviceId: string | null): Promise<MediaStream> {
  if (!deviceId) return navigator.mediaDevices.getUserMedia({ audio: true });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
  } catch (error) {
    if (!isMissingDeviceError(error)) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

/** 录音入口用：按设置里的优先级挑一个已连接的麦克风打开。 */
export async function openPreferredMicrophone(voice: Pick<VoiceSettings, "microphones"> | undefined): Promise<MediaStream> {
  const saved = voice?.microphones ?? [];
  if (saved.length === 0) return openMicrophone(null);
  let devices: AudioInputDevice[] = [];
  try {
    devices = await listAudioInputs();
  } catch {
    devices = [];
  }
  return openMicrophone(preferredMicrophoneId(effectiveMicrophoneOrder(saved, devices), devices));
}
