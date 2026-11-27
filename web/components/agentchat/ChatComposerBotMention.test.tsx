// 输入框里的 `@Bot` / `@引擎`：补全分组、结构化提及、发送改道 ask_bot 与委托卡片。
import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useAgentChatDraftStore } from "@/stores/useAgentChatDraftStore";
import { useBotAskStore } from "@/stores/useBotAskStore";
import type { BotSummary } from "@/types/bot";
import { resetBotDirectoryForTest } from "./botAskActions";
import ChatComposer from "./ChatComposer";

vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriRuntime: () => true,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@/components/bots/openBotChat", () => ({ openBotChat: vi.fn() }));

const CHAT = "tab-bot-mention";

const reviewer: BotSummary = {
  id: "b1", name: "Code Reviewer", avatar: "🧐", color: "#334155", persona: "", engineId: "claude",
  autoApproveKinds: [], createdAt: 1, updatedAt: 1, chatId: "bot-b1", effectiveCwd: "/home/b1",
};

let askReply: Promise<unknown>;

function mockBackend() {
  vi.mocked(invoke).mockImplementation(((command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "list_bots": return Promise.resolve([reviewer]);
      case "list_acp_engines": return Promise.resolve([
        { id: "codex", label: "Codex", available: true, requirement: "" },
        { id: "gemini", label: "Gemini", available: false, requirement: "" },
      ]);
      case "search_project_files": return Promise.resolve({ paths: ["src/review.ts"] });
      case "ensure_engine_bot": return Promise.resolve({ ...reviewer, id: "auto-codex", name: "Codex", engineId: args?.engineId, autoCreated: true });
      case "ask_bot": return askReply;
      default: return Promise.resolve(null);
    }
  }) as typeof invoke);
}

function renderComposer({ generating = false } = {}) {
  return render(
    <TooltipProvider>
      <ChatComposer chatId={CHAT} cwd="/repo" phase={generating ? "generating" : "ready"} generating={generating} availableCommands={[]} />
    </TooltipProvider>,
  );
}

function type(value: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBotDirectoryForTest();
  askReply = Promise.resolve({ text: "**LGTM**", stopReason: "end_turn", botChatId: "bot-b1" });
  mockBackend();
  useBotAskStore.setState({ asks: {}, byChat: {}, mentions: {}, bots: null, engines: null });
  useAgentChatStore.getState().dropChat(CHAT);
  useAgentChatStore.getState().setSnapshot(CHAT, { chatId: CHAT, engineId: "claude", phase: "ready" });
  useAgentChatDraftStore.setState({ drafts: {} });
});

describe("ChatComposer @Bot", () => {
  it("@ 先列 Bot，再列可用引擎，最后列文件", async () => {
    renderComposer();
    type("@");
    await waitFor(() => expect(screen.getAllByRole("option").map((option) => option.dataset.suggestionKind)).toEqual(["bot", "engine", "file"]));
    expect(screen.getAllByTestId("composer-suggestion-group")).toHaveLength(3);
    expect(screen.queryByText("Gemini")).toBeNull();
  });

  it("选中 Bot 插入无空格 token，发送改走 ask_bot，当前会话不收这条", async () => {
    renderComposer();
    type("看 @rev");
    const option = await screen.findByRole("option", { name: /Code Reviewer/ });
    fireEvent.click(option);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("看 @Code_Reviewer ");
    type(`${textarea.value}这个 diff`);
    expect(screen.getByTestId("composer-bot-route")).toBeInTheDocument();
    await act(async () => fireEvent.keyDown(textarea, { key: "Enter" }));

    expect(invoke).toHaveBeenCalledWith("ask_bot", expect.objectContaining({ botId: "b1", text: "看 这个 diff", fromChatId: CHAT }));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "prompt_acp_chat")).toBe(false);
    expect(textarea.value).toBe("");
    expect(useBotAskStore.getState().mentions[CHAT]).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId("bot-ask-card")).toHaveAttribute("data-status", "done"));
    expect(screen.getByText("LGTM").tagName).toBe("STRONG");
  });

  it("当前会话生成中也能交给 Bot（卡片不阻塞对话）", async () => {
    askReply = new Promise(() => {});
    renderComposer({ generating: true });
    type("@Code");
    fireEvent.click(await screen.findByRole("option", { name: /Code Reviewer/ }));
    type("@Code_Reviewer hi");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送" })));
    expect(invoke).toHaveBeenCalledWith("ask_bot", expect.objectContaining({ botId: "b1", text: "hi" }));
    expect(screen.getByTestId("bot-ask-card")).toHaveAttribute("data-status", "running");
    expect(screen.getByRole("textbox")).not.toBeDisabled();
  });

  it("@引擎：按当前 cwd 找 / 建默认 Bot 再委托", async () => {
    renderComposer();
    type("@cod");
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    type("@Codex 跑一下测试");
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("ask_bot", expect.objectContaining({ botId: "auto-codex", text: "跑一下测试" })));
    expect(invoke).toHaveBeenCalledWith("ensure_engine_bot", { engineId: "codex", cwd: "/repo" });
  });

  it("只写了 @Bot 没写内容：不发送", async () => {
    renderComposer();
    type("@rev");
    fireEvent.click(await screen.findByRole("option", { name: /Code Reviewer/ }));
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "ask_bot")).toBe(false);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("普通 @文件 仍发给当前会话并转 resource_link", async () => {
    renderComposer();
    type("@src/review.ts 看看");
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" }));
    await act(async () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }));
    const call = vi.mocked(invoke).mock.calls.find(([command]) => command === "prompt_acp_chat");
    expect((call?.[1] as { blocks: Array<{ type: string }> }).blocks.map((block) => block.type)).toEqual(["resource_link", "text"]);
  });
});
