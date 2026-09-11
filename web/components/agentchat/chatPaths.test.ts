import { describe, expect, it } from "vitest";
import type { Workspace } from "@/types";
import { residentAgentChatCwd, samePath } from "./chatPaths";

function workspace(patch: Partial<Workspace>): Workspace {
  return {
    id: patch.name ?? "ws",
    name: "ws",
    createdAt: "2026-01-01T00:00:00Z",
    projects: [],
    ...patch,
  } as Workspace;
}

describe("residentAgentChatCwd", () => {
  it("优先取 Agent Chat 常驻工作空间的路径", () => {
    const workspaces = [
      workspace({ name: "default", isDefault: true, path: "D:/data/default" }),
      workspace({ name: "agent-chat", isAgentChat: true, path: "D:/data/agent-chat" }),
      workspace({ name: "team", path: "D:/work/team" }),
    ];
    expect(residentAgentChatCwd(workspaces)).toBe("D:/data/agent-chat");
  });

  it("常驻工作空间缺失时退回默认工作空间", () => {
    const workspaces = [
      workspace({ name: "default", isDefault: true, path: "D:/data/default" }),
      workspace({ name: "team", path: "D:/work/team" }),
    ];
    expect(residentAgentChatCwd(workspaces)).toBe("D:/data/default");
  });

  it("归档的常驻工作空间不算数", () => {
    const workspaces = [
      workspace({
        name: "agent-chat",
        isAgentChat: true,
        path: "D:/data/agent-chat",
        archivedAt: "2026-01-02T00:00:00Z",
      }),
      workspace({ name: "default", isDefault: true, path: "D:/data/default" }),
    ];
    expect(residentAgentChatCwd(workspaces)).toBe("D:/data/default");
  });

  it("什么都没有时返回空串（调用方按「未选择」处理）", () => {
    expect(residentAgentChatCwd([])).toBe("");
    expect(residentAgentChatCwd([workspace({ name: "team", path: "D:/work/team" })])).toBe("");
  });
});

describe("samePath", () => {
  it("忽略大小写、分隔符与结尾斜杠差异", () => {
    expect(samePath("D:\\Work\\Team\\", "d:/work/team")).toBe(true);
    expect(samePath("D:/work/team", "D:/work/team/app")).toBe(false);
  });
});
