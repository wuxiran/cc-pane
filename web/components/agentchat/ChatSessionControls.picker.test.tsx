import "@/i18n";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpChatSnapshot } from "@/types/agentChat";
import ChatSessionControls from "./ChatSessionControls";
import { switchChatEngine } from "./chatEngineHandoff";
import { loadEnginePrefs, saveEngineModels } from "./enginePrefs";

vi.mock("@/services/agentChatService", () => ({ agentChatService: {
  listEngines: vi.fn(), setModel: vi.fn(), setMode: vi.fn(), setConfigOption: vi.fn(), setAutoApprove: vi.fn(),
} }));
vi.mock("./chatEngineHandoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chatEngineHandoff")>()),
  switchChatEngine: vi.fn().mockResolvedValue(true),
}));

const CHAT = "picker-controls";
const codex: AcpChatSnapshot = {
  chatId: CHAT, engineId: "codex-app-server", phase: "ready", acpSessionId: "s",
  configOptions: [
    { configId: "model", category: "model", type: "select", currentValue: "gpt-6", options: [{ value: "gpt-6", name: "GPT-6-Astra" }, { value: "gpt-5" }] },
    { configId: "mode", category: "mode", type: "select", currentValue: "danger-full-access",
      options: [{ value: "read-only", name: "Read only" }, { value: "danger-full-access", name: "Full access" }] },
    { configId: "reasoning_effort", type: "select", currentValue: "xhigh", options: [{ value: "high" }, { value: "xhigh" }] },
    { configId: "budget", category: "model_config", type: "select", currentValue: "a", options: [{ value: "a" }, { value: "b" }] },
  ],
};

const renderControls = (snapshot = codex) => render(
  <TooltipProvider>
    <ChatSessionControls chatId={CHAT} snapshot={snapshot} cwd="/repo" setupRecovery={false} recoverySelections={{}} onRecoverySelect={() => {}} />
  </TooltipProvider>,
);

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useAgentChatStore.getState().dropChat(CHAT);
  useAgentChatStore.getState().setSnapshot(CHAT, codex);
  vi.mocked(agentChatService.setConfigOption).mockResolvedValue(undefined);
  vi.mocked(agentChatService.listEngines).mockResolvedValue([
    { id: "codex-app-server", label: "Codex App Server", available: true, requirement: "" },
    { id: "claude", label: "Claude Code", available: true, requirement: "" },
  ]);
});

describe("ChatSessionControls with the merged model picker", () => {
  it("replaces the engine/model/access/effort chips with one chip and keeps other config chips", () => {
    renderControls();
    expect(screen.getByTestId("chat-model-picker")).toHaveTextContent("GPT-6-Astra");
    expect(screen.getByTestId("chat-model-picker")).toHaveTextContent("xhigh");
    expect(screen.queryByTestId("chat-engine-switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Full access" })).toBeNull();
    expect(screen.getByRole("button", { name: "a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "权限" })).toBeInTheDocument();
  });

  it("sets model and effort in the same engine, with access in the footer", async () => {
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByTestId("chat-model-picker"));
    const popover = await screen.findByTestId("chat-model-picker-popover");
    expect(within(popover).getByRole("button", { name: /Full access/ })).toBeInTheDocument();
    await user.click(within(popover).getByRole("radio", { name: "high" }));
    expect(agentChatService.setConfigOption).toHaveBeenCalledWith(CHAT, "reasoning_effort", "high");
    await user.click(within(popover).getByRole("option", { name: /gpt-5/ }));
    expect(agentChatService.setConfigOption).toHaveBeenCalledWith(CHAT, "model", "gpt-5");
    expect(loadEnginePrefs("codex-app-server")?.preferredModelId).toBe("gpt-5");
    expect(switchChatEngine).not.toHaveBeenCalled();
    expect(screen.queryByTestId("chat-model-picker-popover")).toBeNull();
  });

  it("picking another engine's model commits the existing handoff flow with that model preferred", async () => {
    const user = userEvent.setup();
    saveEngineModels("claude", [{ modelId: "opus", name: "Opus" }]);
    renderControls();
    await user.click(screen.getByTestId("chat-model-picker"));
    const popover = await screen.findByTestId("chat-model-picker-popover");
    await user.click(await within(popover).findByRole("button", { name: "Claude Code" }));
    expect(switchChatEngine).not.toHaveBeenCalled();
    await user.click(within(popover).getByRole("option", { name: /Opus/ }));
    await waitFor(() => expect(switchChatEngine).toHaveBeenCalledWith(expect.objectContaining({
      chatId: CHAT, cwd: "/repo", target: expect.objectContaining({ id: "claude" }),
    })));
    expect(loadEnginePrefs("claude")?.preferredModelId).toBe("opus");
  });

  it("blocks cross-engine picks while generating or awaiting permission", async () => {
    const user = userEvent.setup();
    saveEngineModels("claude", [{ modelId: "opus", name: "Opus" }]);
    act(() => useAgentChatStore.getState().setSnapshot(CHAT, { ...codex, phase: "generating" }));
    renderControls({ ...codex, phase: "generating" });
    await user.click(screen.getByTestId("chat-model-picker"));
    const popover = await screen.findByTestId("chat-model-picker-popover");
    await user.click(await within(popover).findByRole("button", { name: "Claude Code" }));
    expect(within(popover).getByText("生成中或有待处理的请求时不能切换引擎")).toBeInTheDocument();
    expect(within(popover).getByRole("option", { name: /Opus/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(popover).getByRole("option", { name: /Opus/ }));
    expect(switchChatEngine).not.toHaveBeenCalled();
  });
});
