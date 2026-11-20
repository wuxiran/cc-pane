import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigateToIslandTarget } from "@/lib/island/islandNavigation";
import { respondChatPermission } from "@/stores/agentChatPermissionResponse";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import {
  ISLAND_NAVIGATE_EVENT,
  ISLAND_REQUEST_STATE_EVENT,
  ISLAND_RESPOND_PERMISSION_EVENT,
  type IslandSnapshot,
} from "@/types/island";
import { startIslandBridge } from "./useIslandBridge";

vi.mock("@/lib/island/islandNavigation", () => ({ navigateToIslandTarget: vi.fn(() => Promise.resolve(true)) }));
vi.mock("@/stores/agentChatPermissionResponse", () => ({ respondChatPermission: vi.fn(() => Promise.resolve()) }));

const handlers = new Map<string, (event: { payload: unknown }) => void>();
const CHAT = "island-bridge-chat";

describe("startIslandBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    vi.mocked(listen).mockImplementation(((event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return Promise.resolve(() => handlers.delete(event));
    }) as typeof listen);
    useAgentChatStore.getState().dropChat(CHAT);
  });

  it("pushes an initial snapshot and re-publishes on store changes, skipping identical payloads", async () => {
    const emit = vi.fn<(snapshot: IslandSnapshot) => void>();
    const stop = startIslandBridge(emit);
    expect(emit).toHaveBeenCalledTimes(1);

    useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "ready" });
    useAgentChatStore.getState().enqueuePermission(CHAT, {
      requestKey: "req-1",
      params: { toolCall: { title: "run" }, options: [{ optionId: "ok", name: "OK", kind: "allow_once" }] },
    });
    await Promise.resolve();
    const last = emit.mock.calls.at(-1)?.[0];
    expect(last?.sessions).toEqual([
      expect.objectContaining({ id: CHAT, kind: "chat", state: "needs", cli: "Claude", approval: expect.objectContaining({ requestKey: "req-1" }) }),
    ]);

    const calls = emit.mock.calls.length;
    useAgentChatStore.getState().setConcierge(CHAT, true);
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(calls);
    stop();
  });

  it("answers a state request immediately even when nothing changed", () => {
    const emit = vi.fn();
    const stop = startIslandBridge(emit);
    return Promise.resolve().then(() => {
      handlers.get(ISLAND_REQUEST_STATE_EVENT)?.({ payload: undefined });
      expect(emit).toHaveBeenCalledTimes(2);
      stop();
    });
  });

  it("routes island approvals through the shared respond path and rows through navigation", async () => {
    const stop = startIslandBridge(vi.fn());
    await Promise.resolve();
    handlers.get(ISLAND_RESPOND_PERMISSION_EVENT)?.({ payload: { chatId: CHAT, requestKey: "req-1", optionId: "ok" } });
    expect(respondChatPermission).toHaveBeenCalledWith(CHAT, "req-1", "ok");
    handlers.get(ISLAND_RESPOND_PERMISSION_EVENT)?.({ payload: { chatId: "", requestKey: "x", optionId: null } });
    expect(respondChatPermission).toHaveBeenCalledTimes(1);
    handlers.get(ISLAND_NAVIGATE_EVENT)?.({ payload: { kind: "terminal", id: "pty-1" } });
    expect(navigateToIslandTarget).toHaveBeenCalledWith({ kind: "terminal", id: "pty-1" });
    stop();
  });
});
