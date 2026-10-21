import "@/i18n";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { collectPanels } from "@/lib/paneTree";
import { usePanesStore } from "@/stores/usePanesStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { acquireChatDraft, useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { createDefaultLayout } from "@/stores/panes/layoutLifecycle";
import { createAgentChatLayout } from "@/stores/panes/agentChatLayout";
import { useChatFileActions } from "./useChatFileActions";

vi.mock("@/services/filesystemService", () => ({ filesystemService: { getEntryInfo: vi.fn().mockResolvedValue({ isDir: false, isFile: true }) } }));

beforeEach(() => {
  const normal = createDefaultLayout("CLI");
  const chat = createAgentChatLayout();
  usePanesStore.setState({ layouts: [normal, chat], rootPane: normal.rootPane, activePaneId: normal.activePaneId, currentLayoutId: normal.id });
  useAgentChatStore.setState({ chats: {} });
  useAgentChatDraftStore.setState({ drafts: {} });
});

it("reuses actual editor tabs while preserving chat session, draft and files through layout save/restore", async () => {
  const normalLayoutId = usePanesStore.getState().currentLayoutId;
  const chatId = usePanesStore.getState().openAgentChat("/project")!;
  const origin = usePanesStore.getState().findTabAcrossLayouts(chatId)!;
  const chatLayoutId = origin.layoutId;
  useAgentChatStore.getState().setSnapshot(chatId, { chatId, engineId: "codex", phase: "ready", acpSessionId: "keep-live-session" });
  const token = acquireChatDraft(chatId);
  useAgentChatDraftStore.getState().setText(chatId, token, "Unsent draft stays here");
  const attachment = { name: "result.png", path: "/project/result.png", mimeType: "image/png", data: "AA==" };
  useAgentChatDraftStore.getState().addAttachments(chatId, token, [attachment]);
  const { result } = renderHook(() => useChatFileActions({ chatId, cwd: "/project" }));
  await act(() => result.current.openAttachment(attachment));
  let panel = collectPanels(usePanesStore.getState().rootPane)[0];
  const editorId = panel.tabs.find((tab) => tab.contentType === "editor")!.id;
  expect(panel.activeTabId).toBe(editorId);
  act(() => usePanesStore.getState().selectTab(origin.panel.id, chatId));
  await act(() => result.current.openAttachment(attachment));
  panel = collectPanels(usePanesStore.getState().rootPane)[0];
  expect(panel.tabs.filter((tab) => tab.contentType === "editor")).toHaveLength(1);
  expect(useAgentChatDraftStore.getState().drafts[chatId]).toMatchObject({ text: "Unsent draft stays here", attachments: [attachment] });
  expect(useAgentChatStore.getState().chats[chatId].snapshot?.acpSessionId).toBe("keep-live-session");

  act(() => {
    usePanesStore.getState().switchLayout(normalLayoutId);
    usePanesStore.getState().switchLayout(chatLayoutId);
  });
  expect(usePanesStore.getState().findTabAcrossLayouts(editorId)?.layoutId).toBe(chatLayoutId);
  const payload = JSON.parse(JSON.stringify(usePanesStore.getState().exportLayoutSnapshotPayload()));
  const rehydrate = usePanesStore.persist.getOptions().merge!;
  const restored = rehydrate(payload, usePanesStore.getState());
  const restoredChat = restored.layouts.find((layout) => layout.id === chatLayoutId)!;
  expect(collectPanels(restoredChat.rootPane).flatMap((item) => item.tabs).some((tab) => tab.id === editorId)).toBe(true);
  act(() => { expect(usePanesStore.getState().applyLayoutSnapshotPayload(payload)).toBe(true); });
  expect(usePanesStore.getState().findTabAcrossLayouts(editorId)?.layoutId).toBe(chatLayoutId);
  expect(useAgentChatStore.getState().chats[chatId].snapshot?.acpSessionId).toBe("keep-live-session");
  expect(useAgentChatDraftStore.getState().drafts[chatId].text).toBe("Unsent draft stays here");
});
