import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { compatibleLaunchProfiles } from "./ChatLaunchProfileMenu";
import { loadLaunchProfileId, saveLaunchProfileId } from "./enginePrefs";
import { startConfiguredChat } from "./startConfiguredChat";

vi.mock("@/services/agentChatService", () => ({ agentChatService: {
  start: vi.fn(), get: vi.fn(), setMode: vi.fn(), setModel: vi.fn(), setConfigOption: vi.fn(), prompt: vi.fn(),
} }));

const chatId = "launch-profile-chat";
const ready: AcpChatSnapshot = { chatId, engineId: "codex-app-server", phase: "ready", acpSessionId: "thread-1" };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAgentChatStore.getState().dropChat(chatId);
});

describe("agent chat launch profiles", () => {
  it("passes the chosen profile to the backend and keeps old call shape without one", async () => {
    vi.mocked(agentChatService.start).mockResolvedValue(ready);
    await startConfiguredChat({ chatId, engineId: "codex-app-server", cwd: "/repo", launchProfileId: "relay" });
    expect(agentChatService.start).toHaveBeenCalledWith(
      chatId, "codex-app-server", "/repo", undefined, [], undefined, { launchProfileId: "relay" },
    );

    useAgentChatStore.getState().dropChat(chatId);
    vi.mocked(agentChatService.start).mockClear();
    await startConfiguredChat({ chatId, engineId: "codex-app-server", cwd: "/repo" });
    expect(agentChatService.start).toHaveBeenCalledWith(chatId, "codex-app-server", "/repo", undefined, []);
  });

  it("shows one notice when Codex fell back to ACP compatibility mode", async () => {
    vi.mocked(agentChatService.start).mockResolvedValue({ ...ready, engineId: "codex", transportFallback: "startFailed" });
    await startConfiguredChat({ chatId, engineId: "codex-app-server", cwd: "/repo" });
    const notices = (useAgentChatStore.getState().chats[chatId]?.items ?? [])
      .filter((item) => item.type === "notice");
    expect(notices.map((item) => (item as { text: string }).text))
      .toEqual([i18n.t("agentChatCodexAcpFallback", { ns: "panes" })]);
  });

  it("lists only profiles targeting the engine's CLI and remembers the choice per engine", () => {
    const profiles = [
      { id: "any", name: "Any", targetTools: [] },
      { id: "codex", name: "Codex relay", targetTools: ["codex"] },
      { id: "claude", name: "Claude relay", targetTools: ["claude"] },
    ] as never;
    expect(compatibleLaunchProfiles(profiles, "codex").map((profile) => profile.id)).toEqual(["any", "codex"]);
    expect(compatibleLaunchProfiles(profiles, undefined)).toEqual([]);

    expect(loadLaunchProfileId("codex-app-server")).toBeNull();
    saveLaunchProfileId("codex-app-server", "codex");
    expect(loadLaunchProfileId("codex-app-server")).toBe("codex");
    expect(loadLaunchProfileId("claude")).toBeNull();
    saveLaunchProfileId("codex-app-server", null);
    expect(loadLaunchProfileId("codex-app-server")).toBeNull();
  });
});
