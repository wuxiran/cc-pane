import { beforeEach, describe, expect, it, vi } from "vitest";
import { botService } from "@/services/botService";
import { useBotAskStore } from "@/stores/useBotAskStore";
import type { Bot } from "@/types/bot";
import { askBot, cancelBotAsk } from "./botAskActions";

vi.mock("@/services/botService", () => ({
  botService: {
    list: vi.fn().mockResolvedValue([]),
    ask: vi.fn(),
    cancelAsk: vi.fn().mockResolvedValue(true),
    ensureEngineBot: vi.fn(),
    listenChanged: vi.fn().mockResolvedValue(() => {}),
  },
}));
vi.mock("@/stores/agentChatEvents", () => ({ ensureAgentChatListener: vi.fn() }));
vi.mock("@/components/bots/openBotChat", () => ({ openBotChat: vi.fn() }));

const engineBot: Bot = {
  id: "auto-1", name: "Codex", avatar: "", color: "", persona: "", engineId: "codex",
  cwd: "/repo", autoApproveKinds: [], createdAt: 0, updatedAt: 0, autoCreated: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  useBotAskStore.setState({ asks: {}, byChat: {}, mentions: {}, bots: null, engines: null });
});

describe("askBot", () => {
  it("@Bot：立即插卡片，回复到达后标记完成", async () => {
    vi.mocked(botService.ask).mockResolvedValue({ text: "**done**", stopReason: "end_turn", botChatId: "bot-b1" });
    const id = askBot({ fromChatId: "tab-a", cwd: "/repo", text: "review", mention: { kind: "bot", token: "R", botId: "b1", name: "R" } });
    expect(useBotAskStore.getState().asks[id]).toMatchObject({ status: "running", botId: "b1", fromChatId: "tab-a" });
    await vi.waitFor(() => expect(useBotAskStore.getState().asks[id].status).toBe("done"));
    expect(botService.ask).toHaveBeenCalledWith(id, "b1", "review", "tab-a");
    expect(useBotAskStore.getState().asks[id].reply).toBe("**done**");
    expect(botService.ensureEngineBot).not.toHaveBeenCalled();
  });

  it("@引擎：先找 / 建默认 Bot（按当前 cwd），再走同一条 ask", async () => {
    vi.mocked(botService.ensureEngineBot).mockResolvedValue(engineBot);
    vi.mocked(botService.ask).mockResolvedValue({ text: "ok", stopReason: "end_turn", botChatId: "bot-auto-1" });
    const id = askBot({ fromChatId: "tab-a", cwd: "/repo", text: "hi", mention: { kind: "engine", token: "Codex", engineId: "codex", name: "Codex" } });
    expect(useBotAskStore.getState().asks[id].botId).toBeNull();
    await vi.waitFor(() => expect(useBotAskStore.getState().asks[id].status).toBe("done"));
    expect(botService.ensureEngineBot).toHaveBeenCalledWith("codex", "/repo");
    expect(botService.ask).toHaveBeenCalledWith(id, "auto-1", "hi", "tab-a");
  });

  it("后端返回 cancelled：卡片标为已取消并保留部分回复", async () => {
    vi.mocked(botService.ask).mockResolvedValue({ text: "partial", stopReason: "cancelled", botChatId: "bot-b1" });
    const id = askBot({ fromChatId: "tab-a", cwd: "", text: "x", mention: { kind: "bot", token: "R", botId: "b1", name: "R" } });
    await vi.waitFor(() => expect(useBotAskStore.getState().asks[id].status).toBe("cancelled"));
    expect(useBotAskStore.getState().asks[id].reply).toBe("partial");
  });

  it("失败显示翻译后的原因；BOT_ASK_CANCELLED 视为取消", async () => {
    vi.mocked(botService.ask).mockRejectedValueOnce({ code: "BOT_BUSY", message: "busy" });
    const failed = askBot({ fromChatId: "tab-a", cwd: "", text: "x", mention: { kind: "bot", token: "R", botId: "b1", name: "R" } });
    await vi.waitFor(() => expect(useBotAskStore.getState().asks[failed].status).toBe("failed"));
    expect(useBotAskStore.getState().asks[failed].error).toBeTruthy();

    vi.mocked(botService.ask).mockRejectedValueOnce({ code: "BOT_ASK_CANCELLED", message: "cancelled" });
    const cancelled = askBot({ fromChatId: "tab-a", cwd: "", text: "x", mention: { kind: "bot", token: "R", botId: "b1", name: "R" } });
    await vi.waitFor(() => expect(useBotAskStore.getState().asks[cancelled].status).toBe("cancelled"));
  });
});

describe("cancelBotAsk", () => {
  it("已定 Bot：发后端取消", async () => {
    const pending = deferred<{ text: string; stopReason: string; botChatId: string }>();
    vi.mocked(botService.ask).mockReturnValue(pending.promise);
    const id = askBot({ fromChatId: "tab-a", cwd: "", text: "x", mention: { kind: "bot", token: "R", botId: "b1", name: "R" } });
    await vi.waitFor(() => expect(botService.ask).toHaveBeenCalled());
    cancelBotAsk(id);
    expect(useBotAskStore.getState().asks[id].cancelRequested).toBe(true);
    await vi.waitFor(() => expect(botService.cancelAsk).toHaveBeenCalledWith(id));
    pending.resolve({ text: "", stopReason: "cancelled", botChatId: "bot-b1" });
    await vi.waitFor(() => expect(useBotAskStore.getState().asks[id].status).toBe("cancelled"));
  });

  it("还在准备默认 Bot 时取消：不再发出 ask", async () => {
    const ensure = deferred<Bot>();
    vi.mocked(botService.ensureEngineBot).mockReturnValue(ensure.promise);
    const id = askBot({ fromChatId: "tab-a", cwd: "/repo", text: "x", mention: { kind: "engine", token: "Codex", engineId: "codex", name: "Codex" } });
    cancelBotAsk(id);
    expect(botService.cancelAsk).not.toHaveBeenCalled();
    ensure.resolve(engineBot);
    await vi.waitFor(() => expect(useBotAskStore.getState().asks[id].status).toBe("cancelled"));
    expect(botService.ask).not.toHaveBeenCalled();
  });
});
