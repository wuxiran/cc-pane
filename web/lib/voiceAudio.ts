// 语音录音的音频封装/转码助手。从 VoiceInputButton 抽出，供终端悬浮麦克风与
// agent-chat 麦克风共用（录音编排各自持有，这里只管字节）。

export type AudioPayload = {
  audioBase64: string;
  mimeType: string;
};

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

const WAV_FALLBACK_MIME_TYPES = new Set([
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/flac",
]);

type WebAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export function getRecorderMimeType(): string | undefined {
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

export async function blobToAudioPayload(blob: Blob, preferWav: boolean): Promise<AudioPayload> {
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
    if (isWavFallbackMimeType(blob.type)) {
      return {
        audioBase64: await blobToBase64(blob),
        mimeType: blob.type,
      };
    }
    throw new Error(
      "The voice provider requires WAV/MP3/M4A/OGG/FLAC audio; local WAV conversion failed.",
    );
  }
}

function isWavFallbackMimeType(mimeType: string): boolean {
  const baseType = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return WAV_FALLBACK_MIME_TYPES.has(baseType);
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

  const channels = Array.from({ length: channelCount }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
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
