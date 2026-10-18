import { beforeEach, describe, expect, it } from "vitest";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { useAgentChatStore } from "./useAgentChatStore";

beforeEach(() => useAgentChatStore.setState({ chats: {} }));

const childSnapshot: AcpChatSnapshot = {
  chatId: "child", engineId: "codex", acpSessionId: "child-session", phase: "ready",
};

function replayChild() {
  const store = useAgentChatStore.getState();
  store.beginHistoryReplay("child", "child-session");
  store.addUserMessage("child", "original question");
  store.appendStreamText("child", "assistant", "original answer");
  store.finishHistoryReplay("child", "child-session", true);
}

it("fork transcript is detached and does not carry parent permissions or terminals", () => {
  const store = useAgentChatStore.getState();
  store.addUserMessage("parent", "original question");
  store.appendStreamText("parent", "assistant", "original answer");
  store.enqueuePermission("parent", { requestKey: "approval", params: {} });
  store.setTerminalOutput("parent", {
    terminalId: "live-tool",
    output: "running",
    truncated: false,
  });
  store.seedFork("child", useAgentChatStore.getState().chats.parent.items, "child-session");
  store.appendStreamText("child", "assistant", " child-only");
  const { parent, child } = useAgentChatStore.getState().chats;
  expect(parent.items[1]).toMatchObject({ text: "original answer" });
  expect(child.items[1]).toMatchObject({ text: "original answer child-only" });
  expect(child.pendingPermissions).toEqual([]);
  expect(child.terminals).toEqual({});
  expect(parent.pendingPermissions.map((permission) => permission.requestKey)).toEqual(["approval"]);
});

describe("fork transcript replay identity", () => {
  it.each(["before", "after"])("does not duplicate seeded history when ready arrives %s seed", (readyOrder) => {
    const store = useAgentChatStore.getState();
    store.addUserMessage("parent", "original question");
    store.appendStreamText("parent", "assistant", "original answer");
    const parent = structuredClone(useAgentChatStore.getState().chats.parent);
    if (readyOrder === "before") store.setSnapshot("child", childSnapshot);
    store.seedFork("child", parent.items, "child-session");
    if (readyOrder === "after") store.setSnapshot("child", childSnapshot);
    expect(useAgentChatStore.getState().chats.child.transcriptStart).toBe(0);
    replayChild();
    const child = useAgentChatStore.getState().chats.child;
    expect(child.items.map((item) => "text" in item ? item.text : item.type)).toEqual([
      "original question", "original answer",
    ]);
    expect(child.transcriptSessionId).toBe("child-session");
    expect(useAgentChatStore.getState().chats.parent).toEqual(parent);
  });

  it("preserves older-session prefix while replacing only the forked conversation on replay", () => {
    const store = useAgentChatStore.getState();
    store.addUserMessage("parent", "Previous project conversation");
    store.pushNotice("parent", "Switched project");
    store.setSnapshot("parent", { ...childSnapshot, chatId: "parent", acpSessionId: "parent-session" });
    store.addUserMessage("parent", "original question");
    store.appendStreamText("parent", "assistant", "original answer");
    const parent = structuredClone(useAgentChatStore.getState().chats.parent);
    expect(parent.transcriptStart).toBe(2);
    store.seedFork("child", parent.items, "child-session", parent.transcriptStart);
    store.setSnapshot("child", childSnapshot);
    replayChild();
    const child = useAgentChatStore.getState().chats.child;
    expect(child.items.slice(0, 2)).toEqual(parent.items.slice(0, 2));
    expect(child.items.map((item) => "text" in item ? item.text : item.type)).toEqual([
      "Previous project conversation", "Switched project", "original question", "original answer",
    ]);
    expect(child.transcriptStart).toBe(2);
  });

  it("binds already-replayed native child content without retaining an inferred prefix", () => {
    const store = useAgentChatStore.getState();
    store.addUserMessage("parent", "Parent display-only prefix");
    store.addUserMessage("child", "original question");
    store.appendStreamText("child", "assistant", "original answer");
    store.setSnapshot("child", childSnapshot);
    expect(useAgentChatStore.getState().chats.child.transcriptStart).toBe(2);
    const nativeItems = structuredClone(useAgentChatStore.getState().chats.child.items);
    store.seedFork("child", useAgentChatStore.getState().chats.parent.items, "child-session", 1);
    expect(useAgentChatStore.getState().chats.child.items).toEqual(nativeItems);
    expect(useAgentChatStore.getState().chats.child.transcriptStart).toBe(0);
    replayChild();
    expect(useAgentChatStore.getState().chats.child.items.map((item) => "text" in item ? item.text : item.type)).toEqual([
      "original question", "original answer",
    ]);
  });

  it.each([-3, 9])("bounds the copied prefix length %s to the source transcript", (prefixLength) => {
    const store = useAgentChatStore.getState();
    store.addUserMessage("parent", "source message");
    store.seedFork("child", useAgentChatStore.getState().chats.parent.items, "child-session", prefixLength);
    expect(useAgentChatStore.getState().chats.child.transcriptStart).toBe(prefixLength < 0 ? 0 : 1);
  });
});
