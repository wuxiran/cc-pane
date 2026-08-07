import "@/i18n";
import i18n from "i18next";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettingsStore, useVoiceInputStore } from "@/stores";
import { terminalService, voiceService } from "@/services";
import VoiceInputButton from "./VoiceInputButton";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

let tauriRuntime = true;
vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => tauriRuntime,
}));

vi.mock("@/services/voiceService", () => ({
  voiceService: { transcribe: vi.fn() },
}));
vi.mock("@/services/terminalService", () => ({
  terminalService: { write: vi.fn().mockResolvedValue(undefined) },
}));

const transcribe = vi.mocked(voiceService.transcribe);
const write = vi.mocked(terminalService.write);

// jsdom 未实现 Pointer Capture API，按钮拖拽逻辑需要这些桩
Object.assign(HTMLElement.prototype, {
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  hasPointerCapture: () => false,
});

type RecorderHandler = ((event: Event) => void) | null;

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: RecorderHandler = null;
  onerror: RecorderHandler = null;

  constructor(public stream: unknown, public options?: unknown) {
    MockMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: "audio/webm" }) });
    this.onstop?.(new Event("stop"));
  }
}

const trackStop = vi.fn();
const getUserMedia = vi.fn().mockResolvedValue({
  getTracks: () => [{ stop: trackStop }],
});

function voiceSettings(overrides?: Record<string, unknown>) {
  return {
    enabled: true,
    provider: "dashscope",
    dashscopeApiKey: "key",
    mimoApiKey: "",
    language: "zh",
    enableItn: false,
    maxRecordSeconds: 60,
    ...overrides,
  };
}

function setVoiceSettings(overrides?: Record<string, unknown>) {
  useSettingsStore.setState({
    settings: { voice: voiceSettings(overrides) },
  } as never);
}

function renderButton(props?: Partial<React.ComponentProps<typeof VoiceInputButton>>) {
  return render(
    <TooltipProvider>
      <div style={{ position: "relative" }}>
        <VoiceInputButton sessionId="sess-1" paneId="pane-1" {...props} />
      </div>
    </TooltipProvider>
  );
}

const tRaw = i18n.t as (key: string, options?: Record<string, unknown>) => string;
function tPanes(key: string, options?: Record<string, unknown>) {
  return tRaw(key, { ns: "panes", ...options });
}

describe("VoiceInputButton", () => {
  beforeEach(() => {
    tauriRuntime = true;
    MockMediaRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    setVoiceSettings();
    useVoiceInputStore.setState({ activeTargetId: null, toggleRequest: null });
    transcribe.mockResolvedValue({ text: " hello world " } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("showFloatingButton=false 时完全不渲染悬浮按钮", () => {
    setVoiceSettings({ showFloatingButton: false });
    renderButton();

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("settings 未加载或未设置 showFloatingButton 时按默认显示", () => {
    renderButton();

    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("reports unavailability outside the Tauri runtime", async () => {
    tauriRuntime = false;
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole("button"));

    expect(toast.error).toHaveBeenCalledWith(tPanes("voiceUnavailable"));
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("requires an attached session before recording", async () => {
    const user = userEvent.setup();
    renderButton({ sessionId: null });

    await user.click(screen.getByRole("button"));

    expect(toast.error).toHaveBeenCalledWith(tPanes("voiceNoSession"));
  });

  it("points to settings when voice input is disabled", async () => {
    setVoiceSettings({ enabled: false });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole("button"));

    expect(toast.error).toHaveBeenCalledWith(tPanes("voiceEnableInSettings"));
  });

  it("requires the provider api key", async () => {
    setVoiceSettings({ dashscopeApiKey: "   " });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole("button"));

    expect(toast.error).toHaveBeenCalledWith(tPanes("voiceApiKeyMissing"));
  });

  it("allows the custom provider to record with an empty api key", async () => {
    // 本地 whisper.cpp server 等无鉴权服务：空 key 不拦
    setVoiceSettings({ provider: "custom", customApiKey: "", dashscopeApiKey: "" });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole("button"));

    expect(toast.error).not.toHaveBeenCalledWith(tPanes("voiceApiKeyMissing"));
    expect(getUserMedia).toHaveBeenCalled();
  });

  it("refuses to start while another pane is recording", async () => {
    useVoiceInputStore.setState({ activeTargetId: "other-pane:sess-9" });
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole("button"));

    expect(toast.error).toHaveBeenCalledWith(tPanes("voiceBusyElsewhere"));
  });

  it("records, transcribes and writes the text into the terminal", async () => {
    const user = userEvent.setup();
    renderButton();
    const button = screen.getByRole("button");

    await user.click(button);
    await waitFor(() => expect(MockMediaRecorder.instances).toHaveLength(1));
    expect(useVoiceInputStore.getState().activeTargetId).toBe("pane-1:sess-1");
    expect(MockMediaRecorder.instances[0].state).toBe("recording");

    // 再点一次停止录音 → 转写 → 写入终端
    await user.click(button);

    await waitFor(() => expect(write).toHaveBeenCalledWith("sess-1", "hello world"));
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ language: "zh", enableItn: false })
    );
    expect(toast.success).toHaveBeenCalledWith(tPanes("voiceInserted"));
    expect(trackStop).toHaveBeenCalled();
    expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
  });

  it("surfaces an error when the transcript is empty and does not write", async () => {
    transcribe.mockResolvedValue({ text: "   " } as never);
    const user = userEvent.setup();
    renderButton();
    const button = screen.getByRole("button");

    await user.click(button);
    await waitFor(() => expect(MockMediaRecorder.instances).toHaveLength(1));
    await user.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(write).not.toHaveBeenCalled();
    expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
  });

  it("recovers when microphone access is denied", async () => {
    getUserMedia.mockRejectedValueOnce(new Error("denied"));
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        tPanes("voiceFailed", { error: "denied" })
      )
    );
    expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
  });

  it("starts recording when a matching toggle request arrives from the store", async () => {
    renderButton();

    act(() => {
      useVoiceInputStore.getState().requestToggle("pane-1:sess-1");
    });

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
  });

  it("ignores toggle requests targeted at another pane", async () => {
    renderButton();

    act(() => {
      useVoiceInputStore.getState().requestToggle("pane-2:sess-2");
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops an active recorder when unmounted", async () => {
    const user = userEvent.setup();
    const view = renderButton();
    await user.click(screen.getByRole("button"));
    await waitFor(() => expect(MockMediaRecorder.instances).toHaveLength(1));

    view.unmount();

    expect(MockMediaRecorder.instances[0].state).toBe("inactive");
    expect(trackStop).toHaveBeenCalled();
    expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
    // 取消路径不应触发转写
    expect(transcribe).not.toHaveBeenCalled();
  });
});
