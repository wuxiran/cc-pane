import { describe, it, expect } from "vitest";
import { classifyTask, groupTasks } from "./taskBoardGroups";
import type { TerminalRowWithWorkspace } from "./workspaceTerminals";
import type { TerminalStatusType } from "@/types";

function row(tabId: string, status: TerminalStatusType | null, sessionId = `s-${tabId}`): TerminalRowWithWorkspace {
  return {
    tabId,
    kind: "terminal",
    layoutId: "l1",
    title: tabId,
    firstPrompt: null,
    sessionTitle: null,
    titleRenamed: false,
    pinned: false,
    status,
    toolName: null,
    oscProgress: null,
    sessionCount: 1,
    projectName: "",
    engines: [],
    lastActivityAt: null,
    primarySessionId: status ? sessionId : null,
    workspaceId: null,
    projectPath: null,
  };
}

describe("classifyTask", () => {
  it("实时状态：出错 / 等输入 / 忙碌", () => {
    expect(classifyTask(row("a", "error"), undefined)).toBe("error");
    expect(classifyTask(row("a", "waitingInput"), undefined)).toBe("waiting");
    expect(classifyTask(row("a", "thinking"), undefined)).toBe("working");
    expect(classifyTask(row("a", "toolRunning"), undefined)).toBe("working");
    expect(classifyTask(row("a", "active"), undefined)).toBe("working");
  });

  it("idle + 完成标记 = done；无标记 = settled", () => {
    expect(classifyTask(row("a", "idle"), { reason: "completed", at: 1 })).toBe("done");
    expect(classifyTask(row("a", "idle"), undefined)).toBe("settled");
    expect(classifyTask(row("a", null), undefined)).toBe("settled");
    expect(classifyTask(row("a", "exited"), undefined)).toBe("settled");
  });

  it("重新忙起来的会话不被旧标记卡在等你处理", () => {
    expect(classifyTask(row("a", "thinking"), { reason: "waiting-input", at: 1 })).toBe("working");
    expect(classifyTask(row("a", "toolRunning"), { reason: "completed", at: 1 })).toBe("working");
  });
});

describe("groupTasks", () => {
  it("三段分组，等你处理与进行中按时间从早到晚", () => {
    const rows = [
      row("done", "idle"),
      row("w1", "thinking"),
      row("wait", "waitingInput"),
      row("calm", "idle"),
      row("w2", "toolRunning"),
    ];
    const groups = groupTasks(
      rows,
      { done: { reason: "completed", at: 500 } },
      { "s-w1": 300, "s-w2": 100, "s-wait": 200 },
    );
    expect(groups.needsYou.map((t) => [t.tabId, t.taskKind, t.since])).toEqual([
      ["wait", "waiting", 200],
      ["done", "done", 500],
    ]);
    expect(groups.working.map((t) => t.tabId)).toEqual(["w2", "w1"]);
    expect(groups.settled.map((t) => t.tabId)).toEqual(["calm"]);
  });

  it("无时间戳的排在有时间的之后", () => {
    const groups = groupTasks([row("a", "thinking"), row("b", "thinking")], {}, { "s-b": 10 });
    expect(groups.working.map((t) => [t.tabId, t.since])).toEqual([
      ["b", 10],
      ["a", null],
    ]);
  });
});
