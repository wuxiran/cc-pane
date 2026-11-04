import { describe, expect, it, vi } from "vitest";
import type { ReadAgentTranscriptResult } from "@/types/agentTranscript";
import {
  buildResumeCommand,
  buildSessionDeepLink,
  buildSessionInfoJson,
  readWholeTranscript,
  transcriptToMarkdown,
  type TerminalSessionShareInfo,
} from "./terminalSessionShare";

const base: TerminalSessionShareInfo = {
  cliTool: "claude",
  resumeId: "abc-123",
  cwd: "/work/my app",
  projectPath: "/work/my app",
  runtime: "local",
};

describe("buildResumeCommand", () => {
  it("按 CLI 生成命令，并给本地 cwd 加引号", () => {
    expect(buildResumeCommand(base)).toBe("cd '/work/my app' && claude --resume abc-123");
    expect(buildResumeCommand({ ...base, cliTool: "codex", cwd: undefined })).toBe(
      "codex resume abc-123",
    );
  });

  it("转义 cwd 里的单引号，防止命令注入", () => {
    expect(buildResumeCommand({ ...base, cwd: "/a'; rm -rf ~; '" })).toBe(
      "cd '/a'\\''; rm -rf ~; '\\''' && claude --resume abc-123",
    );
  });

  it("WSL/SSH 不带 cd；未知 CLI、无 id、非法 id 不生成", () => {
    expect(buildResumeCommand({ ...base, runtime: "wsl" })).toBe("claude --resume abc-123");
    expect(buildResumeCommand({ ...base, cliTool: "grok" })).toBeNull();
    expect(buildResumeCommand({ ...base, resumeId: "new" })).toBeNull();
    expect(buildResumeCommand({ ...base, resumeId: "a;rm" })).toBeNull();
  });
});

describe("buildSessionInfoJson", () => {
  it("只输出白名单字段，不带传入的其他内容", () => {
    const leaky = {
      ...base,
      providerId: "p1",
      apiKey: "sk-secret",
      launchExtras: { env: { TOKEN: "sk-secret" } },
    } as TerminalSessionShareInfo;
    const json = buildSessionInfoJson(leaky);
    expect(json).not.toContain("sk-secret");
    expect(JSON.parse(json)).toMatchObject({
      cliTool: "claude",
      resumeId: "abc-123",
      providerId: "p1",
      runtime: "local",
    });
  });
});

describe("buildSessionDeepLink", () => {
  it("生成带编码的链接，用项目路径而不是 cwd", () => {
    const link = buildSessionDeepLink({ ...base, cwd: "/work/worktree" }, "ccpanes");
    const url = new URL(link!);
    expect(url.protocol).toBe("ccpanes:");
    expect(url.host).toBe("v1");
    expect(url.pathname).toBe("/session");
    expect(url.searchParams.get("project")).toBe("/work/my app");
  });

  it("远程会话和不支持恢复的 CLI 不生成链接", () => {
    expect(buildSessionDeepLink({ ...base, runtime: "ssh" })).toBeNull();
    expect(buildSessionDeepLink({ ...base, cliTool: "grok" })).toBeNull();
    expect(buildSessionDeepLink({ ...base, resumeId: undefined })).toBeNull();
  });
});

describe("transcriptToMarkdown", () => {
  it("保留对话和工具名，丢掉推理和工具输出", () => {
    const markdown = transcriptToMarkdown([
      { id: "1", role: "user", text: " 问 " },
      { id: "2", role: "reasoning", text: "SECRET-THINKING" },
      { id: "3", role: "tool", text: "{}", toolName: "Bash" },
      { id: "4", role: "tool", text: "SECRET-OUTPUT" },
      { id: "5", role: "assistant", text: "答" },
    ]);
    expect(markdown).toBe("## User\n\n问\n\n> Tool: `Bash`\n\n## Assistant\n\n答");
  });
});

describe("readWholeTranscript", () => {
  const page = (ids: string[], next?: string): ReadAgentTranscriptResult => ({
    messages: ids.map((id) => ({ id, role: "user", text: id })),
    truncated: Boolean(next),
    hasEarlier: Boolean(next),
    nextBeforeMessageId: next,
  });
  const params = { cliTool: "claude", resumeSessionId: "s" };

  it("向前翻页并按对话顺序拼接", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page(["c", "d"], "c"))
      .mockResolvedValueOnce(page(["a", "b"]));
    const messages = await readWholeTranscript(read, params);
    expect(messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(read.mock.calls[1][0].beforeMessageId).toBe("c");
  });

  it("后端返回错误时抛出，不把半截内容当成功", async () => {
    const read = vi.fn().mockResolvedValue({
      messages: [],
      truncated: false,
      errorCode: "notFound",
      errorMessage: "missing",
    });
    await expect(readWholeTranscript(read, params)).rejects.toThrow("missing");
  });
});
