import { describe, expect, it } from "vitest";
import type { Workspace } from "@/types";
import { residentAgentChatCwd, samePath, toFileUri } from "./chatPaths";

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

describe("platform path semantics", () => {
  it("keeps POSIX case and literal backslashes distinct", () => {
    expect(samePath("/work/Repo", "/work/repo")).toBe(false);
    expect(samePath("/work/a\\b", "/work/a/b")).toBe(false);
    expect(samePath("/work/Repo/", "/work/Repo")).toBe(true);
    expect(samePath("/", "")).toBe(false);
  });
  it("normalizes Windows drive and UNC spelling without treating POSIX as Windows", () => {
    expect(samePath("\\\\SERVER\\Share\\Folder\\", "//server/share/folder")).toBe(true);
    expect(samePath("\\\\?\\C:\\Work\\Repo", "c:/work/repo/")).toBe(true);
    expect(samePath("C:/work/repo", "/C:/work/repo")).toBe(false);
  });
});

describe("toFileUri", () => {
  it.each(["/tmp/a #?%.txt", "/tmp/中文/100%.md", "/tmp/a\\b.txt"])("round-trips POSIX filename %s without query/fragment interpretation", (path) => {
    const uri = new URL(toFileUri(path));
    expect(uri.protocol).toBe("file:");
    expect(uri.hostname).toBe("");
    expect(uri.search).toBe(""); expect(uri.hash).toBe("");
    expect(decodeURIComponent(uri.pathname)).toBe(path);
  });
  it("retains the drive colon while encoding reserved characters in Windows filenames", () => {
    expect(toFileUri("C:\\Work\\a #?%.txt")).toBe("file:///C:/Work/a%20%23%3F%25.txt");
    expect(toFileUri("\\\\?\\C:\\Work\\a%.txt")).toBe("file:///C:/Work/a%25.txt");
  });
  it("places UNC server in the authority and preserves the share path", () => {
    const uri = new URL(toFileUri("\\\\server\\share\\folder\\a #?%.txt"));
    expect(uri.hostname).toBe("server");
    expect(decodeURIComponent(uri.pathname)).toBe("/share/folder/a #?%.txt");
    expect(uri.search).toBe(""); expect(uri.hash).toBe("");
    expect(toFileUri("\\\\?\\UNC\\server\\share\\a%.txt")).toBe("file://server/share/a%25.txt");
  });
});
