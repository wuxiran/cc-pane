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
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ provider: "mimo" }));
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

    await user.click(screen.getByRole("combobox", { name: /语种|Language/i }));
    await user.click(screen.getByRole("option", { name: /自动|Auto/i }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ language: null }));
  });

  it("emits region and numeric maxRecordSeconds updates", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<VoiceSection value={createValue()} onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: /服务地域|Service region/i }));
    await user.click(screen.getByRole("option", { name: /国际|International/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ region: "intl" }));

    fireEvent.change(screen.getByDisplayValue("60"), { target: { value: "120" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxRecordSeconds: 120 }));
  });
});
