import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("lets a blocked setup choose an advertised mode but applies it only after explicit restart", async () => {
    const user = userEvent.setup();
    savePreferredMode("claude", "removed-plan-mode");
    const changed = { ...snapshot, modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "review" }] } };
    vi.mocked(agentChatService.start).mockImplementation(async () => {
      useAgentChatStore.getState().setSnapshot(CHAT, changed);
      return changed;
    });
    renderChat(); await launch();
    await waitFor(() => expect(useAgentChatStore.getState().chats[CHAT].setup?.error).toContain("removed-plan-mode"));
    await user.click(screen.getByRole("button", { name: "default" }));
    await user.click(await screen.findByRole("menuitem", { name: "review" }));
    expect(loadEnginePrefs("claude")?.preferredModeId).toBe("review");
    expect(screen.getByRole("button", { name: "review" })).toBeInTheDocument();
    expect(agentChatService.setMode).not.toHaveBeenCalled();
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(useAgentChatStore.getState().chats[CHAT].setup?.error).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重新启动会话" }));
    await waitFor(() => expect(agentChatService.setMode).toHaveBeenCalledWith(CHAT, "review"));
    expect(agentChatService.prompt).toHaveBeenCalledExactlyOnceWith(CHAT, [{ type: "text", text: "initial task" }]);
    expect(useAgentChatStore.getState().chats[CHAT].setup).toBeNull();
  });

  it("uses current configOptions model choices over stale legacy choices without sending on selection", async () => {
    const user = userEvent.setup();
    savePreferredModel("claude", "removed-model");
    const changed: AcpChatSnapshot = {
      ...snapshot, models: { currentModelId: "removed-model", availableModels: [{ modelId: "removed-model" }] },
      configOptions: [{ configId: "chosen-model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast" }, { value: "careful" }] }],
    };
    vi.mocked(agentChatService.start).mockImplementation(async () => {
      useAgentChatStore.getState().setSnapshot(CHAT, changed);
      return changed;
    });
    renderChat(); await launch();
    await waitFor(() => expect(useAgentChatStore.getState().chats[CHAT].setup?.error).toContain("removed-model"));
    await user.click(screen.getByRole("button", { name: "fast" }));
    await user.click(await screen.findByRole("menuitem", { name: "careful" }));
    expect(loadEnginePrefs("claude")?.preferredModelId).toBe("careful");
    expect(agentChatService.setConfigOption).not.toHaveBeenCalled();
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "重新启动会话" }));
    await waitFor(() => expect(agentChatService.setConfigOption).toHaveBeenCalledWith(CHAT, "chosen-model", "careful"));
    expect(agentChatService.prompt).toHaveBeenCalledExactlyOnceWith(CHAT, [{ type: "text", text: "initial task" }]);
  });

  it.each(["failed", "exited"] as const)("does not expose setup selectors for a genuinely %s process", (phase) => {
    const store = useAgentChatStore.getState();
    store.setSnapshot(CHAT, { ...snapshot, phase });
    const token = store.beginSetup(CHAT)!;
    store.finishSetup(CHAT, token, "setup interrupted by process exit");
    renderChat();
    expect(screen.getByText("会话已结束")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "default" })).toBeNull();
    expect(screen.queryByRole("button", { name: "fast" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
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

  it("applies a model exposed only through configOptions before sending", async () => {
    savePreferredModel("claude", "careful");
    const configOnly: AcpChatSnapshot = {
      ...snapshot, models: undefined,
      configOptions: [{ configId: "chosen-model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast" }, { value: "careful" }] }],
    };
    vi.mocked(agentChatService.start).mockImplementation(async () => {
      useAgentChatStore.getState().setSnapshot(CHAT, configOnly);
      return configOnly;
    });
    let modelDone!: () => void;
    vi.mocked(agentChatService.setConfigOption).mockImplementation(() => new Promise<void>((resolve) => { modelDone = resolve; }));
    renderChat(); await launch();
    expect(agentChatService.setConfigOption).toHaveBeenCalledWith(CHAT, "chosen-model", "careful");
    expect(agentChatService.setModel).not.toHaveBeenCalled();
    expect(agentChatService.prompt).not.toHaveBeenCalled();
    await act(async () => modelDone());
    expect(agentChatService.prompt).toHaveBeenCalledExactlyOnceWith(CHAT, [{ type: "text", text: "initial task" }]);
    expect(loadEnginePrefs("claude")?.models.map((model) => model.modelId)).toEqual(["fast", "careful"]);
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

  it("shows a model-change failure in a ready session without sending a new task", async () => {
    const user = userEvent.setup();
    useAgentChatStore.getState().setSnapshot(CHAT, snapshot);
    vi.mocked(agentChatService.setModel).mockRejectedValue(new Error("model switch rejected"));
    renderChat();
    await user.click(screen.getByRole("button", { name: "fast" }));
    await user.click(await screen.findByRole("menuitem", { name: "careful" }));
    await waitFor(() => expect(useAgentChatStore.getState().chats[CHAT].items).toContainEqual(
      expect.objectContaining({ type: "notice", text: "model switch rejected" }),
    ));
    expect(agentChatService.setModel).toHaveBeenCalledWith(CHAT, "careful");
    expect(loadEnginePrefs("claude")?.preferredModelId).toBe("careful");
    expect(screen.getByRole("button", { name: "fast" })).toBeInTheDocument();
    expect(agentChatService.start).not.toHaveBeenCalled();
    expect(agentChatService.prompt).not.toHaveBeenCalled();
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
