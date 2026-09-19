import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_TOOLS_REQUEST_TIMEOUT_MS, useCliTools } from "./useCliTools";
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

function deferredTools() {
  let resolve!: (tools: CliToolInfo[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CliToolInfo[]>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useCliTools", () => {
  beforeEach(() => {
    vi.mocked(listCliTools).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("挂载时拉取工具列表并结束 loading", async () => {
    const tools = [makeTool(), makeTool({ id: "codex", displayName: "Codex" })];
    vi.mocked(listCliTools).mockResolvedValue(tools);

    const { result } = renderHook(() => useCliTools());
    expect(result.current.loading).toBe(true);
    expect(result.current.getToolById("claude")).toBeUndefined();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tools).toEqual(tools);
    expect(listCliTools).toHaveBeenCalledTimes(1);
  });

  it("拉取失败时保持探测未知，不制造未安装记录", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listCliTools).mockRejectedValue(new Error("ipc down"));

    const { result } = renderHook(() => useCliTools());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tools).toEqual([]);
    expect(result.current.getToolById("claude")).toBeUndefined();
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

  it("检测超时结束 loading，随后成功仍更新真实安装结果", async () => {
    const detection = deferredTools();
    vi.mocked(listCliTools).mockReturnValue(detection.promise);
    vi.useFakeTimers();
    const { result } = renderHook(() => useCliTools());
    await act(async () => { await vi.advanceTimersByTimeAsync(CLI_TOOLS_REQUEST_TIMEOUT_MS); });
    expect(result.current.loading).toBe(false);
    expect(result.current.tools).toEqual([]);

    const tools = [makeTool()];
    await act(async () => { detection.resolve(tools); });
    expect(result.current.tools).toEqual(tools);
    expect(result.current.installedTools).toEqual(tools);
  });

  it("refresh 超时在期限内返回，失败或超时保留上次真实检测结果", async () => {
    vi.mocked(listCliTools).mockResolvedValueOnce([makeTool()]);
    const { result } = renderHook(() => useCliTools());
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.useFakeTimers();
    const detection = deferredTools();
    vi.mocked(listCliTools).mockReturnValueOnce(detection.promise);
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.refresh(); });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLI_TOOLS_REQUEST_TIMEOUT_MS);
      await refresh;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.installedTools).toHaveLength(1);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => { detection.reject(new Error("late IPC error")); });
    expect(result.current.installedTools).toHaveLength(1);
  });

  it.each(["success", "failure"])("旧请求晚到 %s 不覆盖新 refresh 的结果", async (outcome) => {
    const oldRequest = deferredTools();
    const newRequest = deferredTools();
    vi.mocked(listCliTools).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const { result } = renderHook(() => useCliTools());
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.refresh(); });
    const tools = [makeTool({ version: "new" })];
    await act(async () => {
      newRequest.resolve(tools);
      await refresh;
    });
    await act(async () => {
      if (outcome === "success") oldRequest.resolve([makeTool({ installed: false })]);
      else oldRequest.reject(new Error("superseded request"));
    });
    expect(result.current.tools).toEqual(tools);
    expect(result.current.loading).toBe(false);
  });

  it("旧请求完成不提前结束新请求的 loading", async () => {
    const oldRequest = deferredTools();
    const newRequest = deferredTools();
    vi.mocked(listCliTools).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const { result } = renderHook(() => useCliTools());
    act(() => { void result.current.refresh(); });
    await act(async () => { oldRequest.resolve([makeTool()]); });
    expect(result.current.loading).toBe(true);
    expect(result.current.tools).toEqual([]);
    await act(async () => { newRequest.resolve([makeTool({ id: "codex" })]); });
    expect(result.current.tools[0].id).toBe("codex");
  });

  it.each(["success", "failure"])("卸载取消等待且忽略晚到 %s", async (outcome) => {
    vi.useFakeTimers();
    const detection = deferredTools();
    vi.mocked(listCliTools).mockReturnValue(detection.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useCliTools());
    const before = result.current;
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      if (outcome === "success") detection.resolve([makeTool()]);
      else detection.reject(new Error("unmounted request"));
      await before.refresh();
    });
    expect(result.current).toBe(before);
    expect(listCliTools).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
