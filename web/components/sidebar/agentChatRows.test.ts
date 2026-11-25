import { describe, expect, it } from "vitest";
import { emptySession, type AgentChatSessionState } from "@/stores/useAgentChatStore";
import type { AcpChatHistoryEntry, AcpChatSnapshot } from "@/types/agentChat";
import { buildAgentChatRowIndex, chatHistoryEngines, chatStatus, summarizeAgentChat } from "./agentChatRows";

function chat(phase: AcpChatSnapshot["phase"] | null, patch: Partial<AgentChatSessionState> = {}): AgentChatSessionState {
  return {
    ...emptySession(),
    snapshot: phase ? ({ chatId: "c", engineId: "codex", phase, acpSessionId: "acp-1" } as AcpChatSnapshot) : null,
    ...patch,
  };
}

const history: AcpChatHistoryEntry = {
  acpSessionId: "acp-1",
  engineId: "codex",
  cwd: "/w",
  title: "整理侧栏会话卡",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
};

describe("chatStatus", () => {
  it("maps chat phases and pending requests onto terminal statuses", () => {
    expect(chatStatus(undefined)).toBeNull();
    expect(chatStatus(chat(null))).toBeNull();
    expect(chatStatus(chat("starting"))).toBe("initializing");
    expect(chatStatus(chat("failed"))).toBe("error");
    expect(chatStatus(chat("exited"))).toBe("exited");
    expect(chatStatus(chat("generating"))).toBe("thinking");
    expect(chatStatus(chat("ready"))).toBe("idle");
    expect(chatStatus(chat("generating", { pendingPermissions: [{} as never] }))).toBe("waitingInput");
  });
});

describe("buildAgentChatRowIndex", () => {
  it("uses the history title and engine, plus the first user message", () => {
    const state = chat("ready", {
      items: [
        { type: "notice", id: "n", at: 1_000, text: "hello" } as never,
        { type: "user", id: "u", at: 2_000, text: "第一条提问" } as never,
        { type: "assistant", id: "a", at: 95_000, text: "ok" } as never,
      ],
    });
    const index = buildAgentChatRowIndex([{ id: "tab-1", agentEngineId: "claude" }], { "tab-1": state }, [history]);
    expect(index.get("tab-1")).toEqual({
      engines: ["codex"],
      title: "整理侧栏会话卡",
      firstPrompt: "第一条提问",
      status: "idle",
      // 30s 取整
      lastActivityAt: 90_000,
    });
  });

  it("falls back to the tab's preselected engine and history time when the chat has not started", () => {
    const index = buildAgentChatRowIndex([{ id: "tab-2", agentEngineId: "claude" }], {}, []);
    expect(index.get("tab-2")).toEqual({
      engines: ["claude"],
      title: null,
      firstPrompt: null,
      status: null,
      lastActivityAt: null,
    });
  });
});

describe("summarizeAgentChat engines", () => {
  it("合并历史里的 engines 与标签内交接轨迹，按使用顺序去重（最近的在后）", () => {
    const summary = summarizeAgentChat(
      "claude",
      chat("ready", { engineTrail: ["claude", "codex"] }),
      { ...history, engineId: "claude", engines: ["gemini", "claude"] },
    );
    expect(summary.engines).toEqual(["gemini", "claude", "codex"]);
  });

  it("旧历史没有 engines 字段时按单个 engineId 处理", () => {
    expect(chatHistoryEngines({ ...history, engines: undefined })).toEqual(["codex"]);
  });
});
