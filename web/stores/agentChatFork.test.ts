import { expect, it, vi } from "vitest";
import { agentChatService } from "@/services/agentChatService";
import type { AcpChatEvent } from "@/types/agentChat";
import { ensureAgentChatListener } from "./agentChatEvents";
import { useAgentChatStore } from "./useAgentChatStore";

vi.mock("@/services/agentChatService", () => ({ agentChatService: { listen: vi.fn() } }));

it("fork transcript is detached and does not carry parent permissions or terminals", () => {
  useAgentChatStore.setState({ chats: {} });
  const store = useAgentChatStore.getState();
  store.addUserMessage("parent", "original question");
  store.appendStreamText("parent", "assistant", "original answer");
  let dispatch!: (event: AcpChatEvent) => void;
  vi.mocked(agentChatService.listen).mockImplementation(async (handler) => {
    dispatch = handler;
    return () => {};
  });
  ensureAgentChatListener();
  dispatch({ chatId: "parent", kind: "permission_request", payload: { requestKey: "approval", params: {} } });
  store.setTerminalOutput("parent", {
    terminalId: "live-tool",
    output: "running",
    truncated: false,
  });
  store.seedFork("child", useAgentChatStore.getState().chats.parent.items);
  store.appendStreamText("child", "assistant", " child-only");
  const { parent, child } = useAgentChatStore.getState().chats;
  expect(parent.items[1]).toMatchObject({ text: "original answer" });
  expect(child.items[1]).toMatchObject({ text: "original answer child-only" });
  // Assert the transport-level permission identity rather than coupling fork
  // isolation to either the legacy single request or the mainline request queue.
  expect(JSON.stringify(child)).not.toContain('"requestKey":"approval"');
  expect(child.terminals).toEqual({});
  expect(JSON.stringify(parent)).toContain('"requestKey":"approval"');
});
