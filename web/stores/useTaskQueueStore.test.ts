import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskQueueSnapshot } from "@/types/taskQueue";

const { taskQueueServiceMock } = vi.hoisted(() => ({
  taskQueueServiceMock: {
    get: vi.fn(),
    stageClipboardImage: vi.fn(),
    addItem: vi.fn(),
    deleteItem: vi.fn(),
    clear: vi.fn(),
    update: vi.fn(),
    retry: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(() => {}),
  },
}));

vi.mock("@/services/taskQueueService", () => ({ taskQueueService: taskQueueServiceMock }));

import { useTaskQueueStore } from "./useTaskQueueStore";

function makeSnapshot(revision: number, overrides: Partial<TaskQueueSnapshot> = {}): TaskQueueSnapshot {
  return {
    sessionId: "pty-1",
    paused: false,
    unattended: false,
    unattendedSupported: true,
    state: "running",
    reason: null,
    items: [],
    revision,
    updatedAt: revision,
    ...overrides,
  };
}

describe("useTaskQueueStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskQueueServiceMock.subscribe.mockResolvedValue(() => {});
    useTaskQueueStore.getState().cleanup();
    useTaskQueueStore.setState({
      snapshots: new Map(),
      loadingSessions: new Set(),
      mutatingSessions: new Set(),
      errors: new Map(),
    });
  });

  it("loads a snapshot and exposes loading state", async () => {
    let resolve!: (value: TaskQueueSnapshot) => void;
    taskQueueServiceMock.get.mockReturnValue(new Promise((r) => { resolve = r; }));

    const pending = useTaskQueueStore.getState().load("pty-1");
    expect(useTaskQueueStore.getState().loadingSessions.has("pty-1")).toBe(true);

    resolve(makeSnapshot(1));
    await pending;
    expect(useTaskQueueStore.getState().snapshots.get("pty-1")?.revision).toBe(1);
    expect(useTaskQueueStore.getState().loadingSessions.has("pty-1")).toBe(false);
  });

  it("ignores stale event snapshots after a newer mutation response", async () => {
    taskQueueServiceMock.addItem.mockResolvedValue(makeSnapshot(5));
    await useTaskQueueStore.getState().addItem("pty-1", { text: "next", imageRefs: [] });

    useTaskQueueStore.getState().applySnapshot(makeSnapshot(4, { paused: true }));
    expect(useTaskQueueStore.getState().snapshots.get("pty-1")).toEqual(makeSnapshot(5));
  });

  it("keeps mutation errors visible and clears the busy marker", async () => {
    taskQueueServiceMock.update.mockRejectedValue(new Error("not writable"));

    await expect(
      useTaskQueueStore.getState().update("pty-1", { paused: true }),
    ).rejects.toThrow("not writable");

    expect(useTaskQueueStore.getState().errors.get("pty-1")).toBe("not writable");
    expect(useTaskQueueStore.getState().mutatingSessions.has("pty-1")).toBe(false);
  });
});
