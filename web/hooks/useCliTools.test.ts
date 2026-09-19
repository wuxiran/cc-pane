import { renderHook, waitFor, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCliTools } from "./useCliTools";
import { listCliTools } from "@/services/cliToolService";
import type { CliToolInfo } from "@/types";

vi.mock("@/services/cliToolService", () => ({
  listCliTools: vi.fn(),
}));

function makeTool(overrides: Partial<CliToolInfo> = {}): CliToolInfo {
  return {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    versionArgs: ["--version"],
    installed: true,
    version: "1.0.0",
    path: "/usr/local/bin/claude",
    ...overrides,
  };
}

describe("useCliTools", () => {
  beforeEach(() => {
    vi.mocked(listCliTools).mockReset();
  });

  it("挂载时拉取工具列表并结束 loading", async () => {
    const tools = [makeTool(), makeTool({ id: "codex", displayName: "Codex" })];
    vi.mocked(listCliTools).mockResolvedValue(tools);

    const { result } = renderHook(() => useCliTools());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tools).toEqual(tools);
    expect(listCliTools).toHaveBeenCalledTimes(1);
  });

  it("拉取失败时保留静态工具列表、loading 结束且不抛出", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listCliTools).mockRejectedValue(new Error("ipc down"));

    const { result } = renderHook(() => useCliTools());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tools.map((tool) => tool.id)).toEqual(
      ["claude", "codex", "pi", "omp", "gemini", "kimi", "opencode", "cursor", "grok", "jcode"],
    );
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("installedTools 只包含 installed=true 的工具", async () => {
    vi.mocked(listCliTools).mockResolvedValue([
      makeTool({ id: "claude", installed: true }),
      makeTool({ id: "codex", installed: false }),
    ]);

    const { result } = renderHook(() => useCliTools());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.installedTools.map((t) => t.id)).toEqual(["claude"]);
  });

  it("getToolById 命中返回工具，未命中返回 undefined", async () => {
    vi.mocked(listCliTools).mockResolvedValue([makeTool({ id: "claude" })]);

    const { result } = renderHook(() => useCliTools());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.getToolById("claude")?.id).toBe("claude");
    expect(result.current.getToolById("missing")).toBeUndefined();
  });

  it("refresh 重新拉取并更新列表", async () => {
    vi.mocked(listCliTools).mockResolvedValueOnce([makeTool({ id: "claude" })]);

    const { result } = renderHook(() => useCliTools());
    await waitFor(() => expect(result.current.tools).toHaveLength(1));

    vi.mocked(listCliTools).mockResolvedValueOnce([
      makeTool({ id: "claude" }),
      makeTool({ id: "codex" }),
    ]);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.tools.map((t) => t.id)).toEqual(["claude", "codex"]);
    expect(listCliTools).toHaveBeenCalledTimes(2);
  });

  it("检测卡住超过总超时仍显示静态工具列表并结束 loading", async () => {
    vi.mocked(listCliTools).mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCliTools());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_001);
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.tools.length).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
