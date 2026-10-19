import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import ChatPermissionQueue from "./ChatPermissionQueue";

vi.mock("@/services/agentChatService", () => ({ agentChatService: { respondPermission: vi.fn() } }));
const CHAT = "permission-queue-test";
const enqueue = (key: string) => useAgentChatStore.getState().enqueuePermission(CHAT, {
  requestKey: key,
  params: { toolCall: { title: key }, options: [{ optionId: "yes", name: `approve-${key}`, kind: "allow_once" }] },
});
beforeEach(() => {
  vi.clearAllMocks();
  useAgentChatStore.getState().dropChat(CHAT);
});

describe("ChatPermissionQueue", () => {
  it("keeps simultaneous requests queued and removes only the acknowledged request", async () => {
    enqueue("A"); enqueue("B");
    let acknowledge!: () => void;
    vi.mocked(agentChatService.respondPermission).mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const view = render(<ChatPermissionQueue chatId={CHAT} />);
    fireEvent.click(screen.getByRole("button", { name: "approve-A" }));
    expect(screen.getByRole("button", { name: "approve-A" })).toBeDisabled();
    expect(useAgentChatStore.getState().chats[CHAT].pendingPermissions.map((item) => item.requestKey)).toEqual(["A", "B"]);
    // 切标签后重挂载仍保持在途禁用，重复事件不再加一张卡。
    view.unmount();
    act(() => { enqueue("A"); enqueue("C"); });
    render(<ChatPermissionQueue chatId={CHAT} />);
    fireEvent.click(screen.getByRole("button", { name: "approve-A" }));
    expect(agentChatService.respondPermission).toHaveBeenCalledTimes(1);
    await act(async () => acknowledge());
    expect(screen.getByRole("button", { name: "approve-B" })).toBeEnabled();
    expect(useAgentChatStore.getState().chats[CHAT].pendingPermissions.map((item) => item.requestKey)).toEqual(["B", "C"]);
  });

  it("keeps the failed request actionable and retries the same request key", async () => {
    enqueue("A"); enqueue("B");
    vi.mocked(agentChatService.respondPermission).mockRejectedValueOnce(new Error("write failed")).mockResolvedValueOnce(undefined);
    render(<ChatPermissionQueue chatId={CHAT} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "approve-A" })));
    expect(screen.getByRole("alert")).toHaveTextContent("write failed");
    expect(screen.getByRole("button", { name: "approve-A" })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "approve-A" })));
    expect(agentChatService.respondPermission).toHaveBeenNthCalledWith(2, CHAT, "A", "yes");
    expect(screen.getByRole("button", { name: "approve-B" })).toBeEnabled();
  });

  it("ignores a late approval result after cancellation or tab close", async () => {
    enqueue("A");
    let acknowledge!: () => void;
    vi.mocked(agentChatService.respondPermission).mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    render(<ChatPermissionQueue chatId={CHAT} />);
    fireEvent.click(screen.getByRole("button", { name: "approve-A" }));
    act(() => useAgentChatStore.getState().dropChat(CHAT));
    await act(async () => acknowledge());
    expect(useAgentChatStore.getState().chats[CHAT]).toBeUndefined();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
