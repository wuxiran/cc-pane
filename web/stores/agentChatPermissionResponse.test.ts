import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatService } from "@/services/agentChatService";
import { respondChatPermission } from "./agentChatPermissionResponse";
import { useAgentChatStore } from "./useAgentChatStore";

vi.mock("@/services/agentChatService", () => ({ agentChatService: { respondPermission: vi.fn() } }));

const CHAT = "respond-permission-test";
const pending = () => useAgentChatStore.getState().chats[CHAT]?.pendingPermissions ?? [];

describe("respondChatPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentChatStore.getState().dropChat(CHAT);
    useAgentChatStore.getState().enqueuePermission(CHAT, {
      requestKey: "A",
      params: { options: [{ optionId: "yes", name: "yes", kind: "allow_once" }] },
    });
  });

  it("sends the chosen option once and dequeues on success", async () => {
    vi.mocked(agentChatService.respondPermission).mockResolvedValue(undefined);
    await Promise.all([respondChatPermission(CHAT, "A", "yes"), respondChatPermission(CHAT, "A", "yes")]);
    expect(agentChatService.respondPermission).toHaveBeenCalledTimes(1);
    expect(agentChatService.respondPermission).toHaveBeenCalledWith(CHAT, "A", "yes");
    expect(pending()).toEqual([]);
  });

  it("keeps the request with its error when sending fails", async () => {
    vi.mocked(agentChatService.respondPermission).mockRejectedValue(new Error("write failed"));
    await respondChatPermission(CHAT, "A", "yes");
    expect(pending()).toEqual([expect.objectContaining({ requestKey: "A", responding: false, error: "write failed" })]);
  });
});
