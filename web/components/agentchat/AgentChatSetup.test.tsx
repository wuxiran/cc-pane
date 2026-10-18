import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Tab } from "@/types";
import type { AcpChatSnapshot } from "@/types/agentChat";
import AgentChatTabContent from "./AgentChatTabContent";
import { loadEnginePrefs, saveEngineModes, savePreferredConfigOption, savePreferredMode, savePreferredModel } from "./enginePrefs";

vi.mock("@/services/agentChatService", () => ({ agentChatService: {
  listEngines: vi.fn(), listHistory: vi.fn(), get: vi.fn(), listen: vi.fn(), start: vi.fn(),
  setMode: vi.fn(), setModel: vi.fn(), setConfigOption: vi.fn(), prompt: vi.fn(),
} }));
vi.mock("@/services/gitService", () => ({ gitService: { getRepoInfo: vi.fn().mockResolvedValue({ state: "notRepo" }) } }));
vi.mock("./ChatVoiceButton", () => ({ default: () => null }));
vi.mock("./ChatSessionHeader", () => ({ default: () => null }));
vi.mock("./ChatTurnView", () => ({ default: () => null }));
vi.mock("./ChatWelcome", () => ({ default: () => null }));
vi.mock("./ChatChangesPanel", () => ({ default: () => null, collectNetChanges: () => [] }));
vi.mock("./useComposerAttachments", () => ({ useComposerAttachments: () => ({
  attachments: [], clearAttachments: vi.fn(), removeAttachment: vi.fn(), dropHint: false,
  hostRef: { current: null }, attachFromDialog: vi.fn(), pushFileAttachment: vi.fn(), attachClipboardFiles: vi.fn(),
}) }));
const CHAT = "configured-start-test";
const tab = { id: CHAT, title: "Agent", projectPath: "/project", contentType: "agent-chat" } as Tab;
const snapshot: AcpChatSnapshot = {
  chatId: CHAT, engineId: "claude", phase: "ready", acpSessionId: "session-id",
  modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] },
  models: { currentModelId: "fast", availableModels: [{ modelId: "fast" }, { modelId: "careful" }] },
  configOptions: [{ configId: "thinking", category: "thought_level", currentValue: "low", options: [{ value: "low" }, { value: "high" }] }],
};
const renderChat = () => render(<TooltipProvider><AgentChatTabContent tab={tab} /></TooltipProvider>);
async function launch() {
  await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
  await act(async () => { fireEvent.change(screen.getByRole("textbox"), { target: { value: "initial task" } }); });
  await act(async () => { fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); });
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useAgentChatStore.getState().dropChat(CHAT);
  vi.mocked(agentChatService.get).mockResolvedValue(null);
  vi.mocked(agentChatService.listen).mockResolvedValue(() => {});
  vi.mocked(agentChatService.listEngines).mockResolvedValue([{ id: "claude", label: "Claude", available: true, requirement: "" }]);
  vi.mocked(agentChatService.listHistory).mockResolvedValue([]);
  vi.mocked(agentChatService.start).mockImplementation(async () => {
    // 真后端在 start IPC 返回之前就发 ready；不能让此事件提前开放 composer。
    useAgentChatStore.getState().setSnapshot(CHAT, snapshot);
    return snapshot;
  });
  vi.mocked(agentChatService.setMode).mockResolvedValue(undefined);
  vi.mocked(agentChatService.setModel).mockResolvedValue(undefined);
  vi.mocked(agentChatService.setConfigOption).mockResolvedValue(undefined);
  vi.mocked(agentChatService.prompt).mockResolvedValue(undefined);
});

describe("configured first turn", () => {
  it("blocks a cached restriction mode that is no longer advertised without erasing the preference", async () => {
    saveEngineModes("claude", [{ id: "default" }, { id: "plan" }]);
    savePreferredMode("claude", "plan");
    const changed = { ...snapshot, modes: { currentModeId: "default", availableModes: [{ id: "default" }] } };
    vi.mocked(agentChatService.start).mockImplementation(async () => {
      useAgentChatStore.getState().setSnapshot(CHAT, changed);
      return changed;
    });
    renderChat(); await launch();
    await waitFor(() => expect(useAgentChatStore.getState().chats[CHAT].setup?.error).toContain("plan"));
    expect(loadEnginePrefs("claude")?.preferredModeId).toBe("plan");
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新启动会话" })));
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    expect(loadEnginePrefs("claude")?.preferredModeId).toBe("plan");
  });

  it("applies and waits for a restriction mode advertised only through configOptions", async () => {
    savePreferredMode("claude", "plan");
    const configOnly: AcpChatSnapshot = {
      ...snapshot, modes: undefined,
      configOptions: [{ configId: "operating-mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default" }, { value: "plan" }] }],
    };
    vi.mocked(agentChatService.start).mockImplementation(async () => {
      useAgentChatStore.getState().setSnapshot(CHAT, configOnly);
      return configOnly;
    });
    let modeDone!: () => void;
    vi.mocked(agentChatService.setConfigOption).mockImplementation(() => new Promise<void>((resolve) => { modeDone = resolve; }));
    renderChat(); await launch();
    expect(agentChatService.setConfigOption).toHaveBeenCalledWith(CHAT, "operating-mode", "plan");
    expect(agentChatService.setMode).not.toHaveBeenCalled();
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "premature task" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    await act(async () => modeDone());
    expect(agentChatService.prompt).toHaveBeenCalledExactlyOnceWith(CHAT, [{ type: "text", text: "initial task" }]);
    expect(loadEnginePrefs("claude")?.modes?.map((mode) => mode.id)).toEqual(["default", "plan"]);
  });

  it("waits for mode, model and config before either automatic or manual first prompt", async () => {
    savePreferredMode("claude", "plan"); savePreferredModel("claude", "careful"); savePreferredConfigOption("claude", "thinking", "high");
    let modeDone!: () => void; let modelDone!: () => void; let configDone!: () => void;
    vi.mocked(agentChatService.setMode).mockImplementation(() => new Promise<void>((resolve) => { modeDone = resolve; }));
    vi.mocked(agentChatService.setModel).mockImplementation(() => new Promise<void>((resolve) => { modelDone = resolve; }));
    vi.mocked(agentChatService.setConfigOption).mockImplementation(() => new Promise<void>((resolve) => { configDone = resolve; }));
    renderChat(); await launch();
    await waitFor(() => expect(agentChatService.setMode).toHaveBeenCalledWith(CHAT, "plan"));
    expect(agentChatService.setModel).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "premature manual task" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    await act(async () => modeDone());
    expect(agentChatService.setModel).toHaveBeenCalledWith(CHAT, "careful");
    expect(agentChatService.setConfigOption).not.toHaveBeenCalled();
    await act(async () => modelDone());
    expect(agentChatService.setConfigOption).toHaveBeenCalledWith(CHAT, "thinking", "high");
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    await act(async () => configDone());
    expect(agentChatService.prompt).toHaveBeenCalledExactlyOnceWith(CHAT, [{ type: "text", text: "initial task" }]);
    expect(useAgentChatStore.getState().chats[CHAT].setup).toBeNull();
  });

  it("blocks all sends on mode failure and retries configuration with the retained initial task", async () => {
    savePreferredMode("claude", "plan");
    vi.mocked(agentChatService.setMode).mockRejectedValueOnce(new Error("mode denied")).mockResolvedValueOnce(undefined);
    renderChat(); await launch();
    await waitFor(() => expect(useAgentChatStore.getState().chats[CHAT].setup?.error).toBe("mode denied"));
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(useAgentChatStore.getState().chats[CHAT].items.some((item) => item.type === "notice" && item.text === "mode denied")).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "重新启动会话" })));
    expect(agentChatService.setMode).toHaveBeenCalledTimes(2);
    expect(agentChatService.prompt).toHaveBeenCalledExactlyOnceWith(CHAT, [{ type: "text", text: "initial task" }]);
    expect(useAgentChatStore.getState().chats[CHAT].setup).toBeNull();
  });
});
