import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriRuntimeMock, listenIfTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriRuntimeMock: vi.fn(() => true),
  listenIfTauriMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/services/runtime", () => ({
  isTauriRuntime: isTauriRuntimeMock,
  listenIfTauri: listenIfTauriMock,
}));

import { taskQueueService, TaskQueueUnavailableError } from "./taskQueueService";

const snapshot = {
  sessionId: "pty-1",
  paused: false,
  unattended: false,
  unattendedSupported: true,
  state: "running" as const,
  reason: null,
  items: [],
  revision: 1,
  updatedAt: 10,
};

describe("taskQueueService", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(snapshot);
    isTauriRuntimeMock.mockReset().mockReturnValue(true);
    listenIfTauriMock.mockReset().mockResolvedValue(() => {});
  });

  it("uses the desktop IPC contract for queue mutations", async () => {
    await taskQueueService.get("pty-1");
    await taskQueueService.stageClipboardImage("pty-1");
    await taskQueueService.addItem("pty-1", { text: "next", imageRefs: ["image-1"] });
    await taskQueueService.deleteItem("pty-1", "item-1");
    await taskQueueService.clear("pty-1");
    await taskQueueService.update("pty-1", { paused: true });
    await taskQueueService.retry("pty-1", "item-1");

    expect(invokeMock.mock.calls).toEqual([
      ["get_terminal_task_queue", { sessionId: "pty-1" }],
      ["stage_terminal_task_queue_clipboard_image", { sessionId: "pty-1" }],
      ["add_terminal_task_queue_item", {
        sessionId: "pty-1",
        draft: { text: "next", imageRefs: ["image-1"] },
      }],
      ["delete_terminal_task_queue_item", { sessionId: "pty-1", itemId: "item-1" }],
      ["clear_terminal_task_queue", { sessionId: "pty-1" }],
      ["update_terminal_task_queue", { sessionId: "pty-1", patch: { paused: true } }],
      ["retry_terminal_task_queue_item", { sessionId: "pty-1", itemId: "item-1" }],
    ]);
  });

  it("fails closed outside the Tauri runtime", async () => {
    isTauriRuntimeMock.mockReturnValue(false);

    await expect(taskQueueService.get("pty-1")).rejects.toBeInstanceOf(
      TaskQueueUnavailableError,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("subscribes to authoritative snapshot events only on desktop", async () => {
    const handler = vi.fn();
    await taskQueueService.subscribe(handler);

    expect(listenIfTauriMock).toHaveBeenCalledWith("task-queue-updated", expect.any(Function));
    const eventHandler = listenIfTauriMock.mock.calls[0][1];
    eventHandler({ payload: snapshot });
    expect(handler).toHaveBeenCalledWith(snapshot);
  });
});
