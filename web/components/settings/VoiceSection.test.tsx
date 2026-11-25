import "@/i18n";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSettings } from "@/types";
import VoiceSection from "./VoiceSection";

const { transcribe, localStatus, localInstall, localCancelInstall, localRemove } = vi.hoisted(() => ({
  transcribe: vi.fn(),
  localStatus: vi.fn(),
  localInstall: vi.fn(),
  localCancelInstall: vi.fn(),
  localRemove: vi.fn(),
}));
vi.mock("@/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services")>()),
  voiceService: { transcribe, localStatus, localInstall, localCancelInstall, localRemove },
}));
vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => true,
}));

function createValue(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return {
    enabled: false,
    provider: "dashscope",
    dashscopeApiKey: "",
    region: "cn",
    model: "qwen3-asr-flash",
    mimoApiKey: "",
    mimoBaseUrl: "",
    mimoModel: "",
    customApiKey: "",
    customBaseUrl: "http://127.0.0.1:8080/v1",
    customModel: "whisper-1",
    customPreferWav: false,
    localModel: "sense-voice",
    language: null,
    enableItn: false,
    maxRecordSeconds: 60,
    showFloatingButton: true,
    microphones: [],
    customWords: [],
    removeFillerWords: true,
    ...overrides,
  };
}

/** 受控包装：让连续交互看到上一次的结果。 */
function Harness({ initial, onChange }: { initial: VoiceSettings; onChange?: (value: VoiceSettings) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <VoiceSection
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const enumerateDevices = vi.fn();
const getUserMedia = vi.fn();

beforeEach(() => {
  enumerateDevices.mockResolvedValue([
    { kind: "audioinput", deviceId: "default", label: "Default" },
    { kind: "audioinput", deviceId: "usb", label: "USB Mic" },
    { kind: "videoinput", deviceId: "cam", label: "Camera" },
  ]);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { enumerateDevices, getUserMedia, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  transcribe.mockReset();
  localInstall.mockReset().mockResolvedValue(undefined);
  localStatus.mockReset().mockResolvedValue({
    supported: true,
    engineInstalled: false,
    models: [
      { id: "sense-voice", installed: false, downloadSize: 183_244_526, hotwords: false },
      { id: "qwen3-asr", installed: false, downloadSize: 898_944_066, hotwords: true },
    ],
    install: null,
    directory: "/data/voice-local",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VoiceSection", () => {
  it("关闭时只显示转写服务一行，其余分组隐藏", () => {
    render(<VoiceSection value={createValue()} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: /转写服务|Transcribe with/ })).toHaveTextContent(/关闭|Off/);
    expect(screen.queryByRole("region", { name: /输入|Input/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/你的词典|Your dictionary/)).not.toBeInTheDocument();
  });

  it("选一个没填密钥的服务会启用并直接打开配置窗，填的密钥写回设置", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: /转写服务|Transcribe with/ }));
    await user.click(await screen.findByRole("option", { name: /小米 MiMo|Xiaomi MiMo/ }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, provider: "mimo" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("mimo-..."), { target: { value: "mimo-key" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mimoApiKey: "mimo-key" }));
    // MiMo 没有地域选择
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("选「关闭」停用语音输入", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VoiceSection value={createValue({ enabled: true, dashscopeApiKey: "sk" })} onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: /转写服务|Transcribe with/ }));
    await user.click(await screen.findByRole("option", { name: /关闭|Off/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("钥匙按钮打开 DashScope 配置：地域与 ITN", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={createValue({ enabled: true, dashscopeApiKey: "sk" })} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /配置密钥与地址|Manage key/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("switch", { name: /ITN/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ enableItn: true }));

    await user.click(within(dialog).getByRole("combobox", { name: /服务地域|region/i }));
    await user.click(await screen.findByRole("option", { name: /国际|International/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ region: "intl" }));
  });

  it("语种选「自动识别」写回 null", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VoiceSection value={createValue({ enabled: true, dashscopeApiKey: "sk", language: "zh" })} onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: /^语种$|^Language$/ }));
    await user.click(await screen.findByRole("option", { name: /自动识别|Auto/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ language: null }));
  });

  it("麦克风列表：系统默认在前，可把设备上移，去语气词与最长录音可改", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={createValue({ enabled: true, dashscopeApiKey: "sk" })} onChange={onChange} />);

    const list = await screen.findByRole("list", { name: /麦克风|Microphones/ });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent(/系统默认|System default/);
    expect(first).toHaveTextContent(/使用中|In use/);
    expect(second).toHaveTextContent("USB Mic");

    await user.click(within(second).getByRole("button", { name: /上移|up/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      microphones: [{ deviceId: "usb", label: "USB Mic" }, { deviceId: "default", label: "" }],
    }));

    await user.click(screen.getByRole("switch", { name: /去掉语气词|Remove filler/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ removeFillerWords: false }));

    fireEvent.change(screen.getByDisplayValue("60"), { target: { value: "120" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxRecordSeconds: 120 }));
  });

  it("词典：逗号分隔一次加多个，去重，可删除", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={createValue({ enabled: true, dashscopeApiKey: "sk", customWords: ["Tauri"] })} onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: /添加词条|Add a word/ });
    await user.type(input, "CC-Panes，tauri, Zustand{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ customWords: ["Tauri", "CC-Panes", "Zustand"] }));

    await user.click(screen.getByRole("button", { name: /删除 Tauri|Remove Tauri/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ customWords: ["CC-Panes", "Zustand"] }));
  });

  it("试一下：录一句后用草稿设置转写并显示去掉语气词的结果", async () => {
    const user = userEvent.setup();
    const track = { stop: vi.fn() };
    getUserMedia.mockResolvedValue({ getTracks: () => [track] });
    let recorder: { onstop: (() => void) | null; ondataavailable: ((event: { data: Blob }) => void) | null; state: string } | null = null;
    class FakeRecorder {
      state = "inactive";
      mimeType = "audio/webm";
      onstop: (() => void) | null = null;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      constructor() { recorder = this; }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["abc"], { type: "audio/webm" }) });
        this.onstop?.();
      }
      static isTypeSupported() { return true; }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal("AudioContext", undefined);
    transcribe.mockResolvedValue({ text: "嗯，打开设置", language: null, emotion: null, duration: null });

    const value = createValue({ enabled: true, dashscopeApiKey: "sk-draft", customWords: ["CC-Panes"] });
    render(<VoiceSection value={value} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /录一句|^Record$/ }));
    await waitFor(() => expect(recorder).not.toBeNull());
    await user.click(await screen.findByRole("button", { name: /停止|Stop/ }));

    expect(await screen.findByRole("status", { name: /试转写结果|Test transcript/ })).toHaveTextContent("打开设置");
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      settingsOverride: expect.objectContaining({ dashscopeApiKey: "sk-draft", customWords: ["CC-Panes"], enabled: true }),
    }));
    expect(track.stop).toHaveBeenCalled();
    await act(async () => {});
    vi.unstubAllGlobals();
  });

  it("选本机转写：模型没下载时直接打开模型窗，可下载、可切换模型", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: /转写服务|Transcribe with/ }));
    await user.click(await screen.findByRole("option", { name: /本机转写|On this device/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, provider: "local" }));

    const dialog = await screen.findByRole("dialog");
    const [senseVoice, qwen3] = within(dialog).getAllByRole("radio");
    expect(senseVoice).toHaveAttribute("aria-checked", "true");
    await user.click(await within(senseVoice).findByRole("button", { name: /下载|Download/ }));
    expect(localInstall).toHaveBeenCalledWith("sense-voice");

    await user.click(qwen3);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ localModel: "qwen3-asr" }));
    // 模型没就绪：转写服务行提示下载，试转写不可用
    expect(screen.getAllByText(/还没下载本机模型|No on-device model yet/).length).toBeGreaterThan(0);
  });

  it("本机模型就绪时显示已就绪，SenseVoice 下词典提示不支持", async () => {
    localStatus.mockResolvedValue({
      supported: true,
      engineInstalled: true,
      models: [
        { id: "sense-voice", installed: true, downloadSize: 0, hotwords: false },
        { id: "qwen3-asr", installed: false, downloadSize: 878_702_423, hotwords: true },
      ],
      install: null,
      directory: "/data/voice-local",
    });
    render(<VoiceSection value={createValue({ enabled: true, provider: "local" })} onChange={vi.fn()} />);

    expect(await screen.findByText(/SenseVoice Small.*(已就绪|ready)/)).toBeInTheDocument();
    expect(screen.getByText(/不支持词典|doesn't support a dictionary/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /录一句|^Record$/ })).toBeEnabled();
  });
});
