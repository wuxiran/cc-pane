import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { startAcpChat } from "./agentChatService";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => true, listenIfTauri: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({ chatId: "c", engineId: "claude", phase: "ready" });
});

describe("startAcpChat", () => {
  it("keeps the local invoke payload unchanged", async () => {
    await startAcpChat("c", "claude", "/repo", undefined, []);
    expect(invoke).toHaveBeenCalledWith("start_acp_chat", {
      chatId: "c", engineId: "claude", cwd: "/repo", resumeAcpSessionId: undefined, autoApproveKinds: [],
    });
    expect(Object.keys(vi.mocked(invoke).mock.calls[0][1] as object)).not.toContain("machineId");
  });

  it("sends the machine and remote OS for a remote launch", async () => {
    await startAcpChat("c", "claude", "~/work", undefined, [], { machineId: "m1", os: "linux" });
    expect(invoke).toHaveBeenCalledWith("start_acp_chat", expect.objectContaining({
      cwd: "~/work", machineId: "m1", remoteOs: "linux",
    }));
  });

  it("omits an unknown remote OS so the backend falls back to POSIX", async () => {
    await startAcpChat("c", "claude", "~", undefined, [], { machineId: "m1", os: null });
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ machineId: "m1", remoteOs: undefined });
  });
});
