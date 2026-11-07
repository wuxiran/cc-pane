import "@/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentChatStore, type AgentChatSessionState } from "@/stores/useAgentChatStore";
import { useDockChatStore } from "@/stores/useDockChatStore";
import { usePanesStore } from "@/stores/usePanesStore";
import DockChatView, { dockChatStatus, dockChatTitle } from "./DockChatView";

vi.mock("@/components/agentchat/AgentChatTabContent", () => ({
  default: ({ tab, compact }: { tab: { id: string; projectPath: string; contentType: string }; compact?: boolean }) => (
    <div data-testid="chat-body" data-chat-id={tab.id} data-compact={String(Boolean(compact))}>{tab.contentType}:{tab.projectPath}</div>
  ),
}));
vi.mock("./DockChatHistory", () => ({ default: () => <div data-testid="history" /> }));

function session(patch: Partial<AgentChatSessionState>): AgentChatSessionState {
  return { items: [], pendingPermissions: [], snapshot: null, setup: null, pendingPrompt: null, ...patch } as unknown as AgentChatSessionState;
}

function renderView() {
  return render(
    <TooltipProvider>
      <DockChatView defaultCwd="/repo" workspaces={[]} workspace={null} project={null} onOpenTerminal={vi.fn()} />
    </TooltipProvider>,
  );
}

describe("DockChatView", () => {
  beforeEach(() => {
    localStorage.clear();
    useDockChatStore.setState({ chats: [], activeId: null, historyOpen: false, historyTab: "chat" });
    useAgentChatStore.setState({ chats: {} });
  });

  it("没有对话时自动开一个新对话，用虚拟 agent-chat 标签渲染", () => {
    renderView();

    const [entry] = useDockChatStore.getState().chats;
    expect(entry).toMatchObject({ cwd: "/repo" });
    expect(screen.getByTestId("chat-body")).toHaveAttribute("data-chat-id", entry.id);
    expect(screen.getByTestId("chat-body")).toHaveTextContent("agent-chat:/repo");
    // 面板里走窄版：不带会话顶栏、启动页问候和最近会话。
    expect(screen.getByTestId("chat-body")).toHaveAttribute("data-compact", "true");
    expect(screen.getByRole("tab", { name: "新对话" })).toHaveAttribute("aria-selected", "true");
  });

  it("标题取第一条用户消息，开聊后记下引擎和会话号", () => {
    const id = useDockChatStore.getState().newChat("/repo");
    useAgentChatStore.setState({
      chats: {
        [id]: session({
          items: [{ type: "user", id: "u", at: 1, text: "修一下  unknown browser tab" }] as AgentChatSessionState["items"],
          snapshot: { engineId: "codex", acpSessionId: "acp-9", phase: "ready" } as AgentChatSessionState["snapshot"],
        }),
      },
    });

    renderView();

    expect(screen.getByRole("tab", { name: "修一下 unknown browser tab" })).toBeInTheDocument();
    expect(useDockChatStore.getState().chats[0]).toMatchObject({ engineId: "codex", acpSessionId: "acp-9", title: "修一下 unknown browser tab" });
  });

  it("在窗格中打开：用同一个 chatId 开 agent-chat 标签，面板里摘掉但不停会话", async () => {
    const user = userEvent.setup();
    const id = useDockChatStore.getState().newChat("/repo");
    const openAgentChat = vi.spyOn(usePanesStore.getState(), "openAgentChat").mockReturnValue(id);
    renderView();

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(await screen.findByRole("menuitem", { name: "在窗格中打开" }));

    expect(openAgentChat).toHaveBeenCalledWith("/repo", expect.objectContaining({ tabId: id }));
    expect(useDockChatStore.getState().chats.some((chat) => chat.id === id)).toBe(false);
  });

  it("历史按钮切换历史面板", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole("button", { name: "历史" }));

    expect(screen.getByTestId("history")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-body")).not.toBeInTheDocument();
  });
});

describe("dock chat helpers", () => {
  it("等待批准优先于运行中", () => {
    expect(dockChatStatus(undefined)).toBe("idle");
    expect(dockChatStatus(session({ snapshot: { phase: "generating" } as AgentChatSessionState["snapshot"] }))).toBe("running");
    expect(dockChatStatus(session({
      snapshot: { phase: "generating" } as AgentChatSessionState["snapshot"],
      pendingPermissions: [{}] as AgentChatSessionState["pendingPermissions"],
    }))).toBe("attention");
  });

  it("没有显式标题也没有消息时用兜底文案", () => {
    expect(dockChatTitle({ id: "dock-chat-1", title: "", cwd: null, lastViewedAt: 0 }, undefined, "新对话")).toBe("新对话");
  });
});
