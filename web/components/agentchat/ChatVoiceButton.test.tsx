import "@/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toastErr } from "@/lib/feedback";
import { voiceService } from "@/services/voiceService";
import { blobToAudioPayload } from "@/lib/voiceAudio";
import { useSettingsStore, useVoiceInputStore } from "@/stores";
import ChatVoiceButton from "./ChatVoiceButton";

vi.mock("@/lib/feedback", () => ({ toastErr: vi.fn() }));
vi.mock("@/services/runtime", async (original) => ({ ...(await original<object>()), isTauriRuntime: () => true }));
vi.mock("@/services/voiceService", () => ({ voiceService: { transcribe: vi.fn() } }));
vi.mock("@/lib/voiceAudio", () => ({ getRecorderMimeType: () => "audio/webm", blobToAudioPayload: vi.fn() }));
class Recorder {
  static instances: Recorder[] = [];
  state = "inactive"; mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: unknown) { Recorder.instances.push(this); }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); }
}
const getUserMedia = vi.fn();
const media = () => { const stop = vi.fn(); return { stop, stream: { getTracks: () => [{ stop }] } }; };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };
beforeEach(() => {
  vi.clearAllMocks(); Recorder.instances = [];
  vi.stubGlobal("MediaRecorder", Recorder);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  getUserMedia.mockReset();
  useSettingsStore.setState({ settings: { voice: { enabled: true, provider: "dashscope", dashscopeApiKey: "mock", language: "zh", maxRecordSeconds: 60 } } } as never);
  useVoiceInputStore.setState({ activeTargetId: null, toggleRequest: null });
  vi.mocked(blobToAudioPayload).mockResolvedValue({ audioBase64: "AA==", mimeType: "audio/webm" });
  vi.mocked(voiceService.transcribe).mockResolvedValue({ text: "recognized" } as never);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ChatVoiceButton recording ownership", () => {
  it("releases a permission result arriving after unmount without recording or transcribing", async () => {
    const permission = deferred<ReturnType<typeof media>["stream"]>(); const late = media();
    getUserMedia.mockReturnValue(permission.promise);
    const onText = vi.fn(); const view = render(<ChatVoiceButton chatId="closed" onText={onText} />);
    await click("语音输入"); view.unmount();
    expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
    await act(async () => permission.resolve(late.stream));
    expect(late.stop).toHaveBeenCalledTimes(1); expect(Recorder.instances).toHaveLength(0);
    expect(voiceService.transcribe).not.toHaveBeenCalled(); expect(onText).not.toHaveBeenCalled();
  });

  it("stopping while permission is pending cancels the attempt and releases its late stream", async () => {
    const permission = deferred<ReturnType<typeof media>["stream"]>(); const late = media();
    getUserMedia.mockReturnValue(permission.promise);
    render(<ChatVoiceButton chatId="cancelled" onText={vi.fn()} />);
    await click("语音输入"); await click("停止录音");
    expect(screen.getByRole("button", { name: "语音输入" })).toBeEnabled();
    await act(async () => permission.resolve(late.stream));
    expect(late.stop).toHaveBeenCalledTimes(1); expect(Recorder.instances).toHaveLength(0);
    expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("an old cancelled permission %s cannot touch a newer recording", async (result) => {
    const first = deferred<ReturnType<typeof media>["stream"]>(); const old = media(); const next = media();
    getUserMedia.mockReturnValueOnce(first.promise).mockResolvedValueOnce(next.stream);
    const onText = vi.fn(); render(<ChatVoiceButton chatId="same-chat" onText={onText} />);
    await click("语音输入"); await click("停止录音"); await click("语音输入");
    expect(Recorder.instances).toHaveLength(1);
    await act(async () => { if (result === "resolve") first.resolve(old.stream); else first.reject(new Error("late rejection")); });
    expect(Recorder.instances[0].state).toBe("recording"); expect(next.stop).not.toHaveBeenCalled();
    expect(useVoiceInputStore.getState().activeTargetId).toBe("agent-chat:same-chat");
    expect(toastErr).not.toHaveBeenCalled();
    if (result === "resolve") expect(old.stop).toHaveBeenCalledTimes(1);
    await click("停止录音");
    await waitFor(() => expect(onText).toHaveBeenCalledWith("recognized"));
    expect(next.stop).toHaveBeenCalledTimes(1); expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
  });

  it("reports an authorization failure and permits a new attempt", async () => {
    const next = media(); getUserMedia.mockRejectedValueOnce(new Error("permission denied")).mockResolvedValueOnce(next.stream);
    render(<ChatVoiceButton chatId="denied" onText={vi.fn()} />);
    await click("语音输入");
    expect(toastErr).toHaveBeenCalled(); expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
    await click("语音输入"); expect(Recorder.instances).toHaveLength(1); expect(Recorder.instances[0].state).toBe("recording");
  });

  it("unmounting a live recording stops resources without uploading the cancelled audio", async () => {
    const current = media(); getUserMedia.mockResolvedValue(current.stream);
    const view = render(<ChatVoiceButton chatId="recording" onText={vi.fn()} />);
    await click("语音输入"); view.unmount();
    expect(Recorder.instances[0].state).toBe("inactive"); expect(current.stop).toHaveBeenCalledTimes(1);
    expect(blobToAudioPayload).not.toHaveBeenCalled(); expect(voiceService.transcribe).not.toHaveBeenCalled();
  });

  it("does not start an upload if the view closes during audio conversion", async () => {
    const audio = deferred<{ audioBase64: string; mimeType: string }>();
    vi.mocked(blobToAudioPayload).mockReturnValue(audio.promise);
    getUserMedia.mockResolvedValue(media().stream);
    const view = render(<ChatVoiceButton chatId="encoding" onText={vi.fn()} />);
    await click("语音输入"); await click("停止录音"); view.unmount();
    await act(async () => audio.resolve({ audioBase64: "AA==", mimeType: "audio/webm" }));
    expect(voiceService.transcribe).not.toHaveBeenCalled();
  });

  it("a closed view's transcription cannot edit text or release the new view's ownership", async () => {
    const response = deferred<{ text: string }>(); vi.mocked(voiceService.transcribe).mockReturnValue(response.promise as never);
    const first = media(); const second = media(); getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const oldOnText = vi.fn(); const view = render(<ChatVoiceButton chatId="remounted" onText={oldOnText} />);
    await click("语音输入"); await click("停止录音");
    await waitFor(() => expect(voiceService.transcribe).toHaveBeenCalled()); view.unmount();
    render(<ChatVoiceButton chatId="remounted" onText={vi.fn()} />); await click("语音输入");
    await act(async () => response.resolve({ text: "late transcript" }));
    expect(oldOnText).not.toHaveBeenCalled(); expect(second.stop).not.toHaveBeenCalled();
    expect(useVoiceInputStore.getState().activeTargetId).toBe("agent-chat:remounted");
  });
});
