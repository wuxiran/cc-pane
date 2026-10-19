import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import ChatComposer from "./ChatComposer";
vi.mock("./ChatVoiceButton", () => ({ default: () => null }));
vi.mock("@/services/runtime", async (original) => ({ ...(await original<object>()), isTauriRuntime: () => true }));
const CHAT = "prompt-submission-test";
const ready = () => useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "ready" });
const composer = () => render(<TooltipProvider><ChatComposer chatId={CHAT} cwd="/repo" phase="ready" generating={false} availableCommands={[]} /></TooltipProvider>);
function deferred() { let resolve!: () => void; let reject!: (error: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let submissions: ReturnType<typeof deferred>[];
let clipboardPaths: string[];
const calls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "prompt_acp_chat");
const paste = async (path: string) => {
  clipboardPaths = [path];
  await act(async () => fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [], files: [], getData: () => "" } }));
};
beforeEach(() => {
  vi.clearAllMocks(); submissions = []; clipboardPaths = [];
  useAgentChatStore.getState().dropChat(CHAT); ready();
  vi.mocked(invoke).mockImplementation(((command: string) => {
    if (command === "read_clipboard_file_paths") return Promise.resolve(clipboardPaths);
    if (command === "prompt_acp_chat") { const pending = deferred(); submissions.push(pending); return pending.promise; }
    return Promise.resolve(null);
  }) as typeof invoke);
});

describe("per-chat prompt submission ownership", () => {
  it("blocks repeated retry and manual send across remounts, including IPC success before generating", async () => {
    useAgentChatStore.getState().addUserMessage(CHAT, "previous task", [], [{ type: "text", text: "previous task" }]);
    const view = composer();
    fireEvent.click(screen.getByRole("button", { name: "重试上一轮" }));
    fireEvent.click(screen.getByRole("button", { name: "重试上一轮" }));
    expect(calls()).toHaveLength(1);
    expect(useAgentChatStore.getState().beginSetup(CHAT)).toBeNull();
    view.unmount(); composer();
    expect(screen.getByRole("button", { name: "重试上一轮" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new draft" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(calls()).toHaveLength(1); expect(screen.getByRole("textbox")).toHaveValue("new draft");
    await act(async () => submissions[0].resolve());
    expect(useAgentChatStore.getState().chats[CHAT].pendingPrompt).toBeNull();
    expect(useAgentChatStore.getState().chats[CHAT].snapshot?.phase).toBe("generating");
    expect(screen.getByRole("button", { name: "重试上一轮" })).toBeDisabled();
    act(ready);
    expect(screen.getByRole("button", { name: "重试上一轮" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重试上一轮" }));
    expect(calls()).toHaveLength(2);
    await act(async () => submissions[1].resolve());
  });

  it("removes only the rejected optimistic bubble and preserves both original blocks and a newer draft", async () => {
    composer();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "original request" } });
    await paste("/repo/original.pdf");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const originalArgs = calls()[0][1];
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new unsent text" } });
    await paste("/repo/new.pdf");
    await act(async () => submissions[0].reject(new Error("busy rejection")));
    const rejected = useAgentChatStore.getState().chats[CHAT];
    expect(rejected.items.filter((item) => item.type === "user")).toHaveLength(0);
    expect(rejected.rejectedPrompt?.text).toBe("original request");
    expect(rejected.rejectedPrompt?.attachments?.[0].name).toBe("original.pdf");
    expect(screen.getByRole("textbox")).toHaveValue("new unsent text");
    expect(screen.getByText("new.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试上一轮" }));
    expect(calls()[1][1]).toEqual(originalArgs);
    await act(async () => submissions[1].resolve());
    expect(useAgentChatStore.getState().chats[CHAT].rejectedPrompt).toBeNull();
    expect(useAgentChatStore.getState().chats[CHAT].items.filter((item) => item.type === "user")).toHaveLength(1);
    expect(screen.getByRole("textbox")).toHaveValue("new unsent text");
    expect(screen.getByText("new.pdf")).toBeInTheDocument();
  });

  it("does not turn a completed fast response back into generating when IPC resolves late", async () => {
    composer(); fireEvent.change(screen.getByRole("textbox"), { target: { value: "quick request" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    act(() => {
      useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "generating" });
      useAgentChatStore.getState().turnEnded(CHAT, "end_turn"); ready();
    });
    expect(useAgentChatStore.getState().chats[CHAT].pendingPrompt).not.toBeNull();
    await act(async () => submissions[0].resolve());
    expect(useAgentChatStore.getState().chats[CHAT].snapshot?.phase).toBe("ready");
    expect(useAgentChatStore.getState().chats[CHAT].pendingPrompt).toBeNull();
  });

  it("ignores an old rejected IPC after close without clearing a new reservation", async () => {
    const view = composer(); fireEvent.change(screen.getByRole("textbox"), { target: { value: "old request" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    view.unmount(); useAgentChatStore.getState().dropChat(CHAT); ready(); composer();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new request" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const token = useAgentChatStore.getState().chats[CHAT].pendingPrompt?.token;
    await act(async () => submissions[0].reject(new Error("old failure")));
    expect(useAgentChatStore.getState().chats[CHAT].pendingPrompt?.token).toBe(token);
    expect(useAgentChatStore.getState().chats[CHAT].rejectedPrompt).toBeNull();
    expect(useAgentChatStore.getState().chats[CHAT].items).toHaveLength(1);
    await act(async () => submissions[1].resolve());
  });
});
