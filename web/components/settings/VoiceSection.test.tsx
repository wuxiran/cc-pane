import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VoiceSettings } from "@/types";
import VoiceSection from "./VoiceSection";

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
    language: null,
    enableItn: false,
    maxRecordSeconds: 60,
    showFloatingButton: true,
    ...overrides,
  };
}

describe("VoiceSection", () => {
  it("toggles the enabled switch", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VoiceSection value={createValue()} onChange={onChange} />);

    await user.click(screen.getAllByRole("checkbox")[0]);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("shows dashscope fields by default and emits API key changes", () => {
    const onChange = vi.fn();
    render(<VoiceSection value={createValue()} onChange={onChange} />);

    const apiKey = screen.getByPlaceholderText("sk-...");
    fireEvent.change(apiKey, { target: { value: "sk-test" } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dashscopeApiKey: "sk-test" }));
    // mimo 专属字段不渲染
    expect(screen.queryByPlaceholderText("mimo-...")).not.toBeInTheDocument();
  });

  it("switches to the mimo provider via the provider buttons", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VoiceSection value={createValue()} onChange={onChange} />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    await user.click(buttons[1]);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ provider: "mimo" }));
  });

  it("renders custom fields when the custom provider is selected", () => {
    const onChange = vi.fn();
    render(<VoiceSection value={createValue({ provider: "custom" })} onChange={onChange} />);

    // custom 专属：baseUrl + model + WAV 开关；dashscope 专属 region/ITN 不渲染
    fireEvent.change(screen.getByDisplayValue("http://127.0.0.1:8080/v1"), {
      target: { value: "http://127.0.0.1:9000/v1" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ customBaseUrl: "http://127.0.0.1:9000/v1" }),
    );

    fireEvent.change(screen.getByDisplayValue("whisper-1"), { target: { value: "whisper-large-v3" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ customModel: "whisper-large-v3" }),
    );

    // 只有 language 一个下拉（无 region）
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });

  it("emits customPreferWav toggle for the custom provider", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VoiceSection value={createValue({ provider: "custom" })} onChange={onChange} />);

    // checkbox 顺序：enabled → showFloatingButton → customPreferWav（无 ITN）
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(3);
    await user.click(checkboxes[2]);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ customPreferWav: true }));
  });

  it("renders mimo fields when the mimo provider is selected", () => {
    const onChange = vi.fn();
    render(<VoiceSection value={createValue({ provider: "mimo" })} onChange={onChange} />);

    expect(screen.queryByPlaceholderText("sk-...")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("mimo-..."), { target: { value: "mimo-key" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mimoApiKey: "mimo-key" }));

    fireEvent.change(screen.getByPlaceholderText("https://api.xiaomimimo.com/v1"), {
      target: { value: "https://example.com/v1" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mimoBaseUrl: "https://example.com/v1" }),
    );
  });

  it("treats a missing provider as dashscope", () => {
    render(
      <VoiceSection
        value={createValue({ provider: undefined as unknown as VoiceSettings["provider"] })}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText("sk-...")).toBeInTheDocument();
  });

  it("normalizes the auto language option to null", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VoiceSection value={createValue({ language: "zh" })} onChange={onChange} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /语种|Language/i }),
      "",
    );

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ language: null }));
  });

  it("emits region and numeric maxRecordSeconds updates", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VoiceSection value={createValue()} onChange={onChange} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /服务地域|Service region/i }),
      "intl",
    );
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ region: "intl" }));

    fireEvent.change(screen.getByDisplayValue("60"), { target: { value: "120" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxRecordSeconds: 120 }));
  });
});
