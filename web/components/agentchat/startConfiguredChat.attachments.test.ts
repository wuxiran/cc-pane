// 启动页附件随首条消息发出：与会话内输入区同一套 buildPromptBlocks；引擎不收内嵌图片时
// 有路径的图片退回 resource_link；发送被拒时附件留在 rejectedPrompt 里供重试。
import "@/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpChatSnapshot, AgentChatAttachment } from "@/types/agentChat";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { startConfiguredChat } from "./startConfiguredChat";

vi.mock("@/services/agentChatService", () => ({ agentChatService: {
  start: vi.fn(), get: vi.fn(), setMode: vi.fn(), setModel: vi.fn(), setConfigOption: vi.fn(), prompt: vi.fn(),
} }));
vi.mock("@/services/localLaunchService", () => ({ prepareLocalSessionCwd: async (cwd: string) => cwd }));

const chatId = "start-attachments";
const engineId = "claude";
const snapshot = (image: boolean): AcpChatSnapshot => ({
  chatId, engineId, phase: "ready", acpSessionId: "s1",
  agentCapabilities: { promptCapabilities: { image } },
});
const file: AgentChatAttachment = { name: "a.md", mimeType: "", data: "", kind: "file", path: "/repo/a.md" };
const image: AgentChatAttachment = { name: "b.png", mimeType: "image/png", data: "QUJD", kind: "image", path: "/repo/b.png" };

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useAgentChatStore.getState().dropChat(chatId);
  vi.mocked(agentChatService.prompt).mockResolvedValue(undefined);
});

describe("startConfiguredChat first attachments", () => {
  it("sends attachments with the first prompt in one request", async () => {
    vi.mocked(agentChatService.start).mockResolvedValue(snapshot(true));
    await startConfiguredChat({ chatId, engineId, cwd: "/repo", firstPrompt: "Review", firstAttachments: [file, image] });
    expect(agentChatService.prompt).toHaveBeenCalledExactlyOnceWith(chatId, [
      { type: "resource_link", uri: "file:///repo/a.md", name: "a.md" },
      { type: "image", mimeType: "image/png", data: "QUJD" },
      { type: "text", text: "Review" },
    ]);
    const user = useAgentChatStore.getState().chats[chatId]?.items.find((item) => item.type === "user");
    expect(user).toMatchObject({ text: "Review", attachmentLabels: ["a.md", "b.png"] });
  });

  it("sends an attachment-only first message and downgrades images the engine cannot embed", async () => {
    vi.mocked(agentChatService.start).mockResolvedValue(snapshot(false));
    await startConfiguredChat({ chatId, engineId, cwd: "/repo", firstAttachments: [image] });
    expect(agentChatService.prompt).toHaveBeenCalledExactlyOnceWith(chatId, [
      { type: "resource_link", uri: "file:///repo/b.png", name: "b.png" },
    ]);
  });

  it("keeps the attachments for retry when the first prompt is rejected", async () => {
    vi.mocked(agentChatService.start).mockResolvedValue(snapshot(true));
    vi.mocked(agentChatService.prompt).mockRejectedValue(new Error("busy"));
    await expect(startConfiguredChat({ chatId, engineId, cwd: "/repo", firstPrompt: "Review", firstAttachments: [file] }))
      .rejects.toThrow("busy");
    const chat = useAgentChatStore.getState().chats[chatId];
    expect(chat?.rejectedPrompt).toMatchObject({ text: "Review", attachments: [file] });
    expect(chat?.setup?.firstAttachments).toEqual([file]);
  });
});
