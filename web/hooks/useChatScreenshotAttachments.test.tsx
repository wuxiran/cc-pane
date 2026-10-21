import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Panel, Tab } from "@/types";
import { usePanesStore } from "@/stores/usePanesStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { useChatScreenshotAttachments } from "./useChatScreenshotAttachments";

const { listeners, readImage, unlisten, registration } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  readImage: vi.fn(), unlisten: vi.fn(), registration: { finish: null as Promise<void> | null },
}));
vi.mock("@/services/runtime", async (original) => ({
  ...(await original<object>()),
  listenIfTauri: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === "screenshot-finished" && registration.finish) {
      return registration.finish.then(() => { listeners.set(name, handler); return unlisten; });
    }
    listeners.set(name, handler); return Promise.resolve(unlisten);
  }),
}));
vi.mock("@/services/agentChatService", () => ({ agentChatService: { readImageAttachment: readImage } }));

function select(id: string, type = "agent-chat") {
  const rootPane: Panel = { type: "panel", id: "pane", activeTabId: id, tabs: [{ id, contentType: type } as Tab] };
  usePanesStore.setState({ rootPane, activePaneId: "pane" });
}
const capture = { captureId: "capture-1" };
const finished = { ...capture, result: { filePath: "/tmp/capture.png", width: 200, height: 100 } };
async function emit(name: string, payload: unknown) { await act(async () => { await Promise.resolve(); listeners.get(name)?.({ payload }); }); }
function draft(id: string) { return useAgentChatDraftStore.getState().drafts[id]?.attachments ?? []; }

beforeEach(() => {
  listeners.clear(); vi.clearAllMocks(); registration.finish = null;
  for (const id of ["chat-a", "chat-b"]) {
    useAgentChatStore.getState().dropChat(id);
    useAgentChatStore.getState().setSnapshot(id, { chatId: id, engineId: "test", phase: "ready" });
  }
  select("chat-a");
});

describe("capture routing to chat drafts", () => {
  it("attaches once to the chat selected at capture start even after switching chat", async () => {
    renderHook(useChatScreenshotAttachments);
    await emit("screenshot-started", capture);
    select("chat-b");
    await emit("screenshot-finished", finished);
    await emit("screenshot-finished", finished);
    expect(draft("chat-a")).toEqual([{ name: "capture.png", kind: "file", path: "/tmp/capture.png", mimeType: "", data: "" }]);
    expect(draft("chat-b")).toEqual([]);
  });

  it("ignores terminal-origin screenshots and captures without a matching start", async () => {
    renderHook(useChatScreenshotAttachments);
    await emit("screenshot-finished", finished);
    select("terminal", "terminal");
    await emit("screenshot-started", capture);
    select("chat-a");
    await emit("screenshot-finished", finished);
    expect(draft("chat-a")).toEqual([]);
  });

  it("does not revive closed/recreated chats, including an image read already in flight", async () => {
    let resolveImage!: (result: { dataBase64: string; mimeType: string }) => void;
    readImage.mockReturnValue(new Promise((resolve) => { resolveImage = resolve; }));
    useAgentChatStore.getState().setSnapshot("chat-a", { chatId: "chat-a", engineId: "test", phase: "ready", agentCapabilities: { promptCapabilities: { image: true } } });
    renderHook(useChatScreenshotAttachments);
    await emit("screenshot-started", capture);
    await emit("screenshot-finished", finished);
    useAgentChatStore.getState().dropChat("chat-a");
    useAgentChatStore.getState().setSnapshot("chat-a", { chatId: "chat-a", engineId: "test", phase: "ready" });
    await emit("screenshot-started", { captureId: "new" });
    await act(async () => resolveImage({ mimeType: "image/png", dataBase64: "YWJj" }));
    expect(draft("chat-a")).toEqual([]);
  });

  it("cleans up cancelled capture targets and reports failures only to the original chat", async () => {
    renderHook(useChatScreenshotAttachments);
    await emit("screenshot-started", capture);
    await emit("screenshot-finished", { ...capture, result: null, error: null });
    await emit("screenshot-finished", finished);
    expect(draft("chat-a")).toEqual([]);
    await emit("screenshot-started", { captureId: "error" });
    select("chat-b");
    await emit("screenshot-finished", { captureId: "error", error: "Capture failed" });
    expect(useAgentChatStore.getState().chats["chat-a"].items).toEqual(expect.arrayContaining([expect.objectContaining({ type: "notice", text: "Capture failed" })]));
    expect(useAgentChatStore.getState().chats["chat-b"].items).toEqual([]);
  });

  it("arms completion before accepting starts so an immediate completion cannot be lost", async () => {
    let ready!: () => void;
    registration.finish = new Promise<void>((resolve) => { ready = resolve; });
    renderHook(useChatScreenshotAttachments);
    expect(listeners.has("screenshot-started")).toBe(false);
    await act(async () => ready());
    expect([...listeners.keys()]).toEqual(["screenshot-finished", "screenshot-started"]);
    await act(async () => {
      listeners.get("screenshot-started")?.({ payload: capture });
      listeners.get("screenshot-finished")?.({ payload: finished });
    });
    expect(draft("chat-a")).toHaveLength(1);
  });

  it("does not register a start listener after unmount during delayed setup", async () => {
    let ready!: () => void;
    registration.finish = new Promise<void>((resolve) => { ready = resolve; });
    const view = renderHook(useChatScreenshotAttachments);
    view.unmount();
    await act(async () => ready());
    expect(listeners.has("screenshot-started")).toBe(false);
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("releases both event listeners on app unmount", async () => {
    const view = renderHook(useChatScreenshotAttachments);
    await act(async () => {});
    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
