import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toastInfo } from "@/lib/feedback";
import { useTodoReminders } from "./useTodoReminders";
import { todoService } from "@/services";
import type { TodoItem } from "@/types";

vi.mock("@/lib/feedback", () => ({
  toastInfo: vi.fn(),
  toastErr: vi.fn(),
}));

vi.mock("@/services", () => ({
  todoService: {
    checkReminders: vi.fn(),
  },
}));

vi.mock("@/i18n", () => ({
  default: {
    t: vi.fn((key: string, opts?: { title?: string }) => `${key}:${opts?.title ?? ""}`),
  },
}));

function makeTodo(id: string, title = `todo-${id}`): TodoItem {
  return {
    id,
    title,
    status: "todo",
    priority: "medium",
    scope: "global",
    tags: [],
    todoType: "task",
    myDay: false,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    subtasks: [],
  };
}

describe("useTodoReminders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(todoService.checkReminders).mockReset().mockResolvedValue([]);
    vi.mocked(toastInfo).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("启动 5 秒后开始首次轮询，之后每 60 秒轮询一次", async () => {
    renderHook(() => useTodoReminders());

    await vi.advanceTimersByTimeAsync(4_999);
    expect(todoService.checkReminders).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(todoService.checkReminders).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(todoService.checkReminders).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(todoService.checkReminders).toHaveBeenCalledTimes(3);
  });

  it("到期 Todo 触发 toast，且 8 秒时长、带标题文案", async () => {
    vi.mocked(todoService.checkReminders).mockResolvedValue([makeTodo("t1", "买牛奶")]);
    renderHook(() => useTodoReminders());

    await vi.advanceTimersByTimeAsync(5_000);

    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith(
      "todoReminderTriggered:买牛奶",
      { duration: 8000 },
    );
  });

  it("同一 Todo 在 10 分钟内不重复通知", async () => {
    vi.mocked(todoService.checkReminders).mockResolvedValue([makeTodo("t1")]);
    renderHook(() => useTodoReminders());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(toastInfo).toHaveBeenCalledTimes(1);

    // 下一轮轮询（60s）同一 todo 仍到期，但在 10 分钟静默期内
    await vi.advanceTimersByTimeAsync(60_000);
    expect(todoService.checkReminders).toHaveBeenCalledTimes(2);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it("10 分钟静默期过后允许再次通知", async () => {
    vi.mocked(todoService.checkReminders).mockResolvedValue([makeTodo("t1")]);
    renderHook(() => useTodoReminders());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(toastInfo).toHaveBeenCalledTimes(1);

    // 600s 静默期结束后的下一轮轮询会再次通知
    await vi.advanceTimersByTimeAsync(660_000);
    expect(vi.mocked(toastInfo).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("多个到期 Todo 各自通知一次", async () => {
    vi.mocked(todoService.checkReminders).mockResolvedValue([
      makeTodo("t1", "A"),
      makeTodo("t2", "B"),
    ]);
    renderHook(() => useTodoReminders());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(toastInfo).toHaveBeenCalledTimes(2);
  });

  it("轮询失败静默吞掉，不影响后续轮询", async () => {
    vi.mocked(todoService.checkReminders)
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue([makeTodo("t1")]);
    renderHook(() => useTodoReminders());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(toastInfo).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it("卸载后清理定时器，不再轮询", async () => {
    const { unmount } = renderHook(() => useTodoReminders());

    await vi.advanceTimersByTimeAsync(5_000);
    expect(todoService.checkReminders).toHaveBeenCalledTimes(1);

    unmount();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(todoService.checkReminders).toHaveBeenCalledTimes(1);
  });

  it("初始延迟内卸载则完全不轮询", async () => {
    const { unmount } = renderHook(() => useTodoReminders());
    await vi.advanceTimersByTimeAsync(2_000);
    unmount();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(todoService.checkReminders).not.toHaveBeenCalled();
  });
});
