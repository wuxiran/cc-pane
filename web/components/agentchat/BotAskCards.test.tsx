import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { useBotAskStore } from "@/stores/useBotAskStore";
import type { AcpPermissionRequest } from "@/types/agentChat";
import BotAskCards, { botAskStage, isLongReply } from "./BotAskCards";
import { cancelBotAsk, openAskBotChat } from "./botAskActions";

vi.mock("./botAskActions", () => ({ cancelBotAsk: vi.fn(), openAskBotChat: vi.fn() }));

const CHAT = "tab-cards";

function start(id: string, botId: string | null = "b1") {
  useBotAskStore.getState().start({ id, fromChatId: CHAT, text: "look at the diff", target: { name: "Reviewer", avatar: "🧐", color: "" }, botId });
}

function renderCards() {
  return render(<TooltipProvider><BotAskCards chatId={CHAT} cwd="/repo" /></TooltipProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useBotAskStore.setState({ asks: {}, byChat: {}, mentions: {}, bots: null, engines: null });
  useAgentChatStore.getState().dropChat("bot-b1");
});

describe("botAskStage", () => {
  const base = { botId: "b1", admitted: false, cancelRequested: false };
  it("按取消 → 是否定 Bot → 是否接下 → Bot 相位判定", () => {
    expect(botAskStage({ ...base, cancelRequested: true, admitted: true }, "generating")).toBe("cancelling");
    expect(botAskStage({ ...base, botId: null }, undefined)).toBe("preparing");
    expect(botAskStage({ ...base, admitted: true }, "generating")).toBe("replying");
    expect(botAskStage(base, "generating")).toBe("queued");
    expect(botAskStage(base, "ready")).toBe("waiting");
    expect(botAskStage(base, undefined)).toBe("starting");
    expect(botAskStage(base, "starting")).toBe("starting");
  });

  it("长回复判定", () => {
    expect(isLongReply("short")).toBe(false);
    expect(isLongReply("x".repeat(801))).toBe(true);
    expect(isLongReply(Array.from({ length: 13 }, () => "l").join("\n"))).toBe(true);
  });
});

describe("BotAskCards", () => {
  it("没有委托时不渲染", () => {
    const { container } = renderCards();
    expect(container).toBeEmptyDOMElement();
  });

  it("进行中：显示阶段与取消", () => {
    start("a1");
    useAgentChatStore.getState().setSnapshot("bot-b1", { chatId: "bot-b1", engineId: "claude", phase: "generating" });
    renderCards();
    expect(screen.getByTestId("bot-ask-card")).toHaveAttribute("data-status", "running");
    expect(screen.getByTestId("bot-ask-stage")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /取消|Cancel/ }));
    expect(cancelBotAsk).toHaveBeenCalledWith("a1");
  });

  it("Bot 在等审批：提示去 Bot 对话处理并可跳转", () => {
    start("a1");
    useBotAskStore.getState().markAdmitted("a1");
    useAgentChatStore.getState().enqueuePermission("bot-b1", { requestKey: "k1", params: { options: [] } } as unknown as AcpPermissionRequest);
    renderCards();
    expect(screen.getByTestId("bot-ask-approval")).toBeInTheDocument();
    expect(screen.queryByTestId("bot-ask-stage")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /去审批|Review/ }));
    expect(openAskBotChat).toHaveBeenCalledWith("a1");
  });

  it("完成：Markdown 回复，过长可展开，可打开 Bot 对话并关闭卡片", () => {
    start("a1");
    useBotAskStore.getState().finish("a1", `**结论**\n${"细节\n".repeat(20)}`, false);
    renderCards();
    expect(screen.getByTestId("bot-ask-reply").className).toContain("max-h-48");
    fireEvent.click(screen.getByRole("button", { name: /展开全文|Show all/ }));
    expect(screen.getByTestId("bot-ask-reply").className).not.toContain("max-h-48");
    expect(screen.getByText("结论").tagName).toBe("STRONG");
    fireEvent.click(screen.getByRole("button", { name: /打开 Bot 对话|Open bot chat/ }));
    expect(openAskBotChat).toHaveBeenCalledWith("a1");
    fireEvent.click(screen.getByRole("button", { name: /关闭卡片|Dismiss card/ }));
    expect(screen.queryByTestId("bot-ask-card")).toBeNull();
  });

  it("失败：显示原因", () => {
    start("a1");
    useBotAskStore.getState().fail("a1", "boom");
    renderCards();
    expect(screen.getByRole("alert").textContent).toContain("boom");
  });
});
