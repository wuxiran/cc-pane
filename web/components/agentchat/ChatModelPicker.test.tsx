import "@/i18n";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import ChatModelPicker, { type ChatModelPickerProps } from "./ChatModelPicker";
import { loadModelFavorites } from "./chatModelFavorites";
import type { PickerModelRow } from "./chatModelPickerModel";

const codexRows: PickerModelRow[] = ["gpt-6-astra", "gpt-6", "gpt-5.5", "gpt-5", "o4", "o3", "o2"]
  .map((modelId) => ({ engineId: "codex-app-server", modelId, label: modelId.toUpperCase() }));
const claudeRows: PickerModelRow[] = [{ engineId: "claude", modelId: "opus", label: "Opus" }];

function renderPicker(overrides: Partial<ChatModelPickerProps> = {}) {
  const props: ChatModelPickerProps = {
    engines: [
      { id: "codex-app-server", label: "Codex App Server", available: true },
      { id: "claude", label: "Claude Code", available: true },
      { id: "gemini", label: "Gemini", available: false, requirement: "install gemini" },
    ],
    currentEngineId: "codex-app-server",
    currentModelId: "gpt-6-astra",
    modelsOf: (id) => (id === "codex-app-server" ? codexRows : id === "claude" ? claudeRows : []),
    blockedReason: (id) => (id === "gemini" ? "install gemini" : null),
    effort: {
      option: { configId: "reasoning_effort", currentValue: "xhigh", options: [] },
      current: "xhigh",
      choices: [{ value: "high", label: "high", isDefault: false }, { value: "xhigh", label: "xhigh", isDefault: false }],
    },
    onPickModel: vi.fn(),
    onPickEffort: vi.fn(),
    footer: <button type="button">access-mode</button>,
    ...overrides,
  };
  render(<TooltipProvider><ChatModelPicker {...props} /></TooltipProvider>);
  return props;
}

const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId("chat-model-picker"));
  return screen.findByTestId("chat-model-picker-popover");
};

const optionByLabel = (popover: HTMLElement, label: string) => {
  const match = within(popover).getAllByRole("option").find((option) => option.querySelector("span.truncate")?.textContent === label);
  if (!match) throw new Error(`no option ${label}`);
  return match;
};

beforeEach(() => localStorage.clear());

describe("ChatModelPicker", () => {
  it("shows model and effort on one chip and autofocuses search", async () => {
    const user = userEvent.setup();
    renderPicker();
    const chip = screen.getByTestId("chat-model-picker");
    expect(chip).toHaveTextContent("GPT-6-ASTRA");
    expect(chip).toHaveTextContent("xhigh");
    expect(chip.querySelector('[data-cli-brand="codex"]')).not.toBeNull();
    const popover = await openPicker(user);
    expect(within(popover).getByPlaceholderText("搜索模型…")).toHaveFocus();
    expect(within(popover).getByRole("button", { name: "access-mode" })).toBeInTheDocument();
    expect(within(popover).getByRole("radio", { name: "xhigh" })).toHaveAttribute("aria-checked", "true");
  });

  it("collapses long lists behind show-more and keeps shortcuts on visible rows", async () => {
    const user = userEvent.setup();
    renderPicker();
    const popover = await openPicker(user);
    expect(within(popover).getAllByRole("option")).toHaveLength(6);
    await user.click(within(popover).getByRole("option", { name: /显示更多（2）/ }));
    expect(within(popover).getAllByRole("option")).toHaveLength(7);
  });

  it("browsing another engine does not switch; picking its model does", async () => {
    const user = userEvent.setup();
    const props = renderPicker();
    const popover = await openPicker(user);
    await user.click(within(popover).getByRole("button", { name: "Claude Code" }));
    expect(props.onPickModel).not.toHaveBeenCalled();
    await user.click(optionByLabel(popover, "Opus"));
    expect(props.onPickModel).toHaveBeenCalledWith("claude", "opus");
    expect(screen.queryByTestId("chat-model-picker-popover")).toBeNull();
  });

  it("does not pick rows of a blocked engine", async () => {
    const user = userEvent.setup();
    const props = renderPicker({ modelsOf: (id) => (id === "gemini" ? [{ engineId: "gemini", modelId: "pro", label: "Pro" }] : codexRows) });
    const popover = await openPicker(user);
    await user.click(within(popover).getByRole("button", { name: /Gemini/ }));
    expect(within(popover).getByText("install gemini")).toBeInTheDocument();
    expect(optionByLabel(popover, "Pro")).toHaveAttribute("aria-disabled", "true");
    expect(props.onPickModel).not.toHaveBeenCalled();
  });

  it("supports search, arrow keys + Enter, and the modifier+digit shortcut", async () => {
    const user = userEvent.setup();
    const props = renderPicker();
    let popover = await openPicker(user);
    const input = within(popover).getByPlaceholderText("搜索模型…");
    await user.type(input, "o4");
    expect(within(popover).getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(props.onPickModel).toHaveBeenCalledWith("codex-app-server", "o4");

    popover = await openPicker(user);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(props.onPickModel).toHaveBeenLastCalledWith("codex-app-server", "gpt-6");

    popover = await openPicker(user);
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    fireEvent.keyDown(within(popover).getByPlaceholderText("搜索模型…"), { key: "3", metaKey: isMac, ctrlKey: !isMac });
    expect(props.onPickModel).toHaveBeenLastCalledWith("codex-app-server", "gpt-5.5");
  });

  it("does not re-pick the current model", async () => {
    const user = userEvent.setup();
    const props = renderPicker();
    const popover = await openPicker(user);
    await user.click(optionByLabel(popover, "GPT-6-ASTRA"));
    expect(props.onPickModel).not.toHaveBeenCalled();
  });

  it("stars a model into the persisted favorites view", async () => {
    const user = userEvent.setup();
    const props = renderPicker();
    let popover = await openPicker(user);
    const row = optionByLabel(popover, "GPT-5");
    await user.click(within(row).getByRole("button", { name: "收藏" }));
    expect(props.onPickModel).not.toHaveBeenCalled();
    expect(loadModelFavorites()).toEqual([{ engineId: "codex-app-server", modelId: "gpt-5" }]);
    await user.click(within(popover).getByRole("button", { name: "收藏的模型" }));
    expect(within(popover).getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining("GPT-5")]);
    await user.keyboard("{Escape}");
    popover = await openPicker(user);
    expect(optionByLabel(popover, "GPT-5")).toBeInTheDocument();
  });

  it("applies effort immediately and says when a model has no effort control", async () => {
    const user = userEvent.setup();
    const props = renderPicker();
    const popover = await openPicker(user);
    await user.click(within(popover).getByRole("radio", { name: "high" }));
    expect(props.onPickEffort).toHaveBeenCalledWith("high");
  });

  it("shows the unsupported note without effort levels", async () => {
    const user = userEvent.setup();
    renderPicker({ effort: null });
    const popover = await openPicker(user);
    expect(within(popover).getByText("此模型不支持")).toBeInTheDocument();
    expect(within(popover).queryByRole("radio")).toBeNull();
  });
});
