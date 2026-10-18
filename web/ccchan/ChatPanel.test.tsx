import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CCCHAN_SETTINGS } from "@/stores/useCCChanStore";
import { ChatPanel, cleanupTerminalOutput, type ChatMessage } from "./ChatPanel";

type WebviewListener = (event: { payload: unknown }) => void;

function createWebviewListenerRegistry() {
  const listeners = new Map<string, WebviewListener[]>();
  vi.mocked(getCurrentWebview().listen).mockImplementation(async (eventName, handler) => {
    const existing = listeners.get(eventName) ?? [];
    existing.push(handler as WebviewListener);
    listeners.set(eventName, existing);
    return () => {};
  });

  return {
    emit(eventName: string, payload: unknown) {
      for (const listener of listeners.get(eventName) ?? []) {
        listener({ payload });
      }
    },
    listenerCount(eventName: string) {
      return listeners.get(eventName)?.length ?? 0;
    },
  };
}

function ChatPanelHarness({ initialSessionId = "dead-chat" }: { initialSessionId?: string | null }) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  return (
    <>
      <div data-testid="session-id">{sessionId ?? "none"}</div>
      <ChatPanel
        settings={DEFAULT_CCCHAN_SETTINGS}
        sessionId={sessionId}
        messages={messages}
        onMessagesChange={setMessages}
        onSessionIdChange={setSessionId}
        onClose={() => {}}
      />
    </>
  );
}

describe("ChatPanel session recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createWebviewListenerRegistry();
  });

  it("restarts chat when the stored session is no longer alive", async () => {
    const mockInvoke = invoke as ReturnType<typeof vi.fn>;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "is_ccchan_chat_session_alive") {
        return Promise.resolve(args?.sessionId !== "dead-chat");
      }
      if (cmd === "start_ccchan_chat") return Promise.resolve("new-chat");
      return Promise.resolve(undefined);
    });

    render(<ChatPanelHarness />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("is_ccchan_chat_session_alive", {
        sessionId: "dead-chat",
      });
    });
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("start_ccchan_chat", {
        aiEngine: DEFAULT_CCCHAN_SETTINGS.aiEngine,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("session-id")).toHaveTextContent("new-chat");
    });
  });

  it("refreshes an active chat by showing progress and starting a new session", async () => {
    const mockInvoke = invoke as ReturnType<typeof vi.fn>;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "is_ccchan_chat_session_alive") {
        return Promise.resolve(args?.sessionId === "live-chat" || args?.sessionId === "new-chat");
      }
      if (cmd === "stop_ccchan_chat") return Promise.resolve(undefined);
      if (cmd === "start_ccchan_chat") return Promise.resolve("new-chat");
      return Promise.resolve(undefined);
    });

    render(<ChatPanelHarness initialSessionId="live-chat" />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("is_ccchan_chat_session_alive", {
        sessionId: "live-chat",
      });
    });

    const refreshButton = await screen.findByTitle("刷新会话");
    await waitFor(() => expect(refreshButton).not.toBeDisabled());

    fireEvent.click(refreshButton);

    expect(screen.getAllByText("正在刷新 Claude CLI 会话...").length).toBeGreaterThan(0);
    expect(mockInvoke).toHaveBeenCalledWith("stop_ccchan_chat", { sessionId: "live-chat" });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("start_ccchan_chat", {
        aiEngine: DEFAULT_CCCHAN_SETTINGS.aiEngine,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("session-id")).toHaveTextContent("new-chat");
    });
  });
});

describe("ChatPanel structured chat events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders assistant text from structured events without rendering thinking status as a message", async () => {
    const listeners = createWebviewListenerRegistry();
    const mockInvoke = invoke as ReturnType<typeof vi.fn>;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "is_ccchan_chat_session_alive") {
        return Promise.resolve(args?.sessionId === "live-chat");
      }
      return Promise.resolve(undefined);
    });

    render(<ChatPanelHarness initialSessionId="live-chat" />);

    await waitFor(() => {
      expect(listeners.listenerCount("ccchan-chat-output")).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(listeners.listenerCount("ccchan-chat-status")).toBeGreaterThan(0);
    });

    act(() => {
      listeners.emit("ccchan-chat-status", {
        sessionId: "live-chat",
        status: "thinking",
        message: "Mulling... thinking with high effort",
      });
    });

    expect(screen.queryByText(/Mulling/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/thinking with high effort/i)).not.toBeInTheDocument();

    act(() => {
      listeners.emit("ccchan-chat-output", {
        sessionId: "live-chat",
        role: "assistant",
        text: "你好，我是结构化输出。",
      });
    });

    expect(await screen.findByText("你好，我是结构化输出。")).toBeInTheDocument();
  });
});

describe("cleanupTerminalOutput", () => {
  it("drops Claude startup and TUI chrome that arrives after the user prompt", () => {
    const raw = [
      "│ Tipsforgettingstarted │ Welcomeback! │",
      "│ Run/inittocreateaCLAUDE.mdfilewithinstructionsforCla... │",
      "│ OTEL_RESOURCE_ATTRIBUTES valuesarenowincludedaslabelso... │",
      "│ claudeagents rowsnowshow done/total beforethedetailw... │",
      "│ /mcp nowcollapsesclaude.aiconnectorsyou'veneversigned... │ Opus4.8(1Mcontext)withhi... │",
      "APIUsageBilling │ /release-notesformore │ ~.cc-panes-dev\\ccchan │ │ 你好 ▸ ▸ ( ) high/effort",
    ].join("\n");

    expect(cleanupTerminalOutput(raw)).toBe("");
  });

  it("drops Claude thinking progress lines instead of rendering them as assistant text", () => {
    const raw = [
      "› 测试 · Mulling... *ng... *|g In ⚠ 1 setup issue:",
      "MCP · /doctor > 测试. * Mulling... Muli *In *Mll ui in... +Mll *lig... (5s · thinking with high effort)",
      "n6thinking with high effort +i...thinking with high effort *thinking with high effort *In",
      "*uithinking with high effort ↓ · thinking with high effort) Ml738thinking with high effort",
      "50thinking with high effort 63thinking with high effort *l75thinking with high effort",
      "· thinking with high effort) 49thinking with high effort 1thinking with high effort",
      "5thought for 1s)",
    ].join("\n");

    expect(cleanupTerminalOutput(raw)).toBe("");
  });

  it("keeps natural assistant text readable", () => {
    expect(cleanupTerminalOutput("你好！我在，可以帮你看 CC-Panes 的会话。")).toBe(
      "你好！我在，可以帮你看 CC-Panes 的会话。",
    );
  });
});


describe("chat cancellation and input", () => {
  beforeEach(() => { vi.clearAllMocks(); createWebviewListenerRegistry(); });
  it("does not send Enter while a Chinese input composition is active", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => cmd === "is_ccchan_chat_session_alive" ? true : undefined as never);
    render(<ChatPanelHarness initialSessionId="live-chat" />);
    const input = screen.getByRole("textbox");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "正在输入" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(invoke).not.toHaveBeenCalledWith("send_to_ccchan", expect.anything());
    expect(input).toHaveValue("正在输入");
  });
  it("stops a session that finishes starting after the panel unmounts", async () => {
    let finish!: (id: string) => void;
    vi.mocked(invoke).mockImplementation((cmd) => cmd === "start_ccchan_chat"
      ? new Promise((resolve) => { finish = resolve as (id: string) => void; }) : Promise.resolve(undefined as never));
    const { unmount } = render(<ChatPanelHarness initialSessionId={null} />);
    await waitFor(() => expect(finish).toBeDefined());
    unmount();
    await act(async () => finish("late-chat"));
    expect(invoke).toHaveBeenCalledWith("stop_ccchan_chat", { sessionId: "late-chat" });
  });
});
