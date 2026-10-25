import { beforeEach, expect, it, vi } from "vitest";
import { createPanel } from "@/lib/paneTree";
import { agentChatService } from "@/services/agentChatService";
import { usePanesStore } from "@/stores/usePanesStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { acquireChatDraft, dropAgentChatDraft, useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import type { Tab } from "@/types";
import { addAnnotationToDraft, annotationChatTargets } from "./annotationDraft";

vi.mock("@/services/agentChatService", () => ({ agentChatService: { readImageAttachment: vi.fn() } }));
const saved = { filePath: "/tmp/annotated.png", metadataPath: "/tmp/annotated.annotations.json", markdown: "# Captured issue", dataUrl: "data:image/png;base64,AA==" };
const imageContent: Awaited<ReturnType<typeof agentChatService.readImageAttachment>> = { mimeType: "image/png", dataBase64: "AA==", path: saved.filePath, size: 1 };
const tab = (id: string, title = id): Tab => ({ id, title, contentType: "agent-chat", projectId: "", projectPath: "/repo", sessionId: null });

function start(image = true) {
  const panel = createPanel(tab("chat"));
  usePanesStore.setState({ rootPane: panel, activePaneId: panel.id, currentLayoutId: "live", layouts: [{ id: "live", name: "Live", rootPane: panel, activePaneId: panel.id }] });
  useAgentChatStore.getState().setSnapshot("chat", { chatId: "chat", engineId: "engine", phase: "ready", acpSessionId: "session-1", agentCapabilities: { promptCapabilities: { image } } });
  return panel;
}

beforeEach(() => {
  vi.clearAllMocks();
  dropAgentChatDraft("chat");
  useAgentChatStore.setState({ chats: {} });
});

it("projects the live layout once and excludes stale and starred mirror targets", () => {
  const live = createPanel(tab("chat", "Live"));
  const stale = createPanel(tab("stale"));
  const mirrored = createPanel(tab("mirror-only"));
  const other = createPanel(tab("other"));
  const targets = annotationChatTargets({ rootPane: live, activePaneId: live.id, currentLayoutId: "live", layouts: [
    { id: "live", name: "Live", rootPane: stale, activePaneId: stale.id },
    { id: "stars", name: "Stars", kind: "starred", rootPane: mirrored, activePaneId: mirrored.id },
    { id: "other", name: "Other", rootPane: other, activePaneId: other.id },
  ] });
  expect(targets.map((item) => item.id)).toEqual(["chat", "other"]);
});

it("adds the image and reference to the latest draft without submitting it", async () => {
  start();
  let complete!: (value: typeof imageContent) => void;
  vi.mocked(agentChatService.readImageAttachment).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const token = acquireChatDraft("chat");
  useAgentChatDraftStore.getState().setText("chat", token, "Initial text");
  const handoff = addAnnotationToDraft("chat", saved);
  useAgentChatDraftStore.getState().setText("chat", token, "User continued typing");
  complete(imageContent);
  await handoff;
  expect(useAgentChatDraftStore.getState().drafts.chat).toMatchObject({ text: "User continued typing \n\n# Captured issue", attachments: [{ kind: "image", path: saved.filePath, data: "AA==" }] });
  expect(useAgentChatStore.getState().chats.chat.items).toEqual([]);
});

it("rejects a failed image read and preserves the original draft", async () => {
  start();
  const token = acquireChatDraft("chat");
  useAgentChatDraftStore.getState().setText("chat", token, "Keep me");
  vi.mocked(agentChatService.readImageAttachment).mockRejectedValueOnce(new Error("Image unavailable"));
  await expect(addAnnotationToDraft("chat", saved)).rejects.toThrow("Image unavailable");
  expect(useAgentChatDraftStore.getState().drafts.chat).toMatchObject({ text: "Keep me", attachments: [] });
});

it("does not recreate a closed chat or draft when its pending image read completes", async () => {
  start();
  let complete!: (value: typeof imageContent) => void;
  vi.mocked(agentChatService.readImageAttachment).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const handoff = addAnnotationToDraft("chat", saved);
  useAgentChatStore.getState().dropChat("chat");
  const empty = createPanel();
  usePanesStore.setState({ rootPane: empty });
  complete(imageContent);
  await expect(handoff).rejects.toThrow("closed or changed");
  expect(useAgentChatDraftStore.getState().drafts.chat).toBeUndefined();
  expect(useAgentChatStore.getState().chats.chat).toBeUndefined();
});

it("rejects a changed ACP session after the image await", async () => {
  start();
  let complete!: (value: typeof imageContent) => void;
  vi.mocked(agentChatService.readImageAttachment).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const handoff = addAnnotationToDraft("chat", saved);
  useAgentChatStore.getState().setSnapshot("chat", { chatId: "chat", engineId: "engine", phase: "ready", acpSessionId: "session-2" });
  complete(imageContent);
  await expect(handoff).rejects.toThrow("closed or changed");
  expect(useAgentChatDraftStore.getState().drafts.chat).toBeUndefined();
});

it("uses a file reference for engines that do not accept image blocks", async () => {
  start(false);
  await addAnnotationToDraft("chat", saved);
  expect(agentChatService.readImageAttachment).not.toHaveBeenCalled();
  expect(useAgentChatDraftStore.getState().drafts.chat.attachments).toEqual([{ name: "annotated.png", mimeType: "", data: "", kind: "file", path: saved.filePath }]);
});
