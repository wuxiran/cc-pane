import { expect, it } from "vitest";
import { useAgentChatStore } from "./useAgentChatStore";
it("fork transcript is detached and does not carry parent permissions or terminals", () => {
  useAgentChatStore.setState({ chats: {} });
  const store = useAgentChatStore.getState();
  store.addUserMessage("parent", "original question");
  store.appendStreamText("parent", "assistant", "original answer");
  store.enqueuePermission("parent", { requestKey: "approval", params: {} });
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
  expect(child.pendingPermissions).toEqual([]);
  expect(child.terminals).toEqual({});
  expect(parent.pendingPermissions.map((permission) => permission.requestKey)).toEqual(["approval"]);
});
