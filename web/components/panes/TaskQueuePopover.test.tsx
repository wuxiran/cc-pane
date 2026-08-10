import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

import { useTaskQueueStore } from "@/stores/useTaskQueueStore";
import TaskQueuePopover from "./TaskQueuePopover";

function snapshot(overrides: Partial<TaskQueueSnapshot> = {}): TaskQueueSnapshot {
  return {
    sessionId: "pty-1",
    paused: false,
    unattended: false,
    unattendedSupported: true,
    state: "running",
    reason: null,
    items: [],
    revision: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("TaskQueuePopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskQueueServiceMock.subscribe.mockResolvedValue(() => {});
    taskQueueServiceMock.get.mockResolvedValue(snapshot());
    taskQueueServiceMock.addItem.mockResolvedValue(snapshot({ revision: 2 }));
    taskQueueServiceMock.update.mockResolvedValue(snapshot({ revision: 2 }));
    taskQueueServiceMock.stageClipboardImage.mockResolvedValue({
      imageRef: "image-1",
      width: 1280,
      height: 720,
    });
    useTaskQueueStore.getState().cleanup();
    useTaskQueueStore.setState({
      snapshots: new Map(),
      loadingSessions: new Set(),
      mutatingSessions: new Set(),
      errors: new Map(),
    });
  });

  async function openPopover() {
    const user = userEvent.setup();
    render(<TaskQueuePopover sessionId="pty-1" />);
    await user.click(screen.getByRole("button", { name: /任务队列|Task queue/i }));
    return user;
  }

  it("adds a multiline draft with Enter while Shift+Enter stays in the editor", async () => {
    const user = await openPopover();
    const input = await screen.findByRole("textbox", { name: /新任务|New task/i });

    await user.type(input, "first{shift>}{enter}{/shift}second");
    expect(input).toHaveValue("first\nsecond");
    await user.type(input, "{enter}");

    expect(taskQueueServiceMock.addItem).toHaveBeenCalledWith("pty-1", {
      text: "first\nsecond",
      imageRefs: [],
    });
  });

  it("pauses the queue without removing its items", async () => {
    taskQueueServiceMock.get.mockResolvedValue(snapshot({
      items: [{
        id: "item-1",
        sessionId: "pty-1",
        position: 0,
        text: "next task",
        imageRefs: [],
        state: "queued",
        createdAt: 1,
        lastError: null,
      }],
    }));
    const user = await openPopover();

    await user.click(await screen.findByRole("button", { name: /暂停|Pause/i }));
    expect(taskQueueServiceMock.update).toHaveBeenCalledWith("pty-1", { paused: true });
  });

  it("requires an explicit confirmation before enabling unattended mode", async () => {
    const user = await openPopover();
    const toggle = await screen.findByRole("switch", { name: /无人值守|Unattended/i });

    await user.click(toggle);
    expect(taskQueueServiceMock.update).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "无人值守会允许 Claude 在无需逐次确认的情况下使用工具。仅在你信任当前任务和工作区时开启。",
    );

    await user.click(screen.getByRole("button", { name: /确认启用|Enable unattended/i }));
    expect(taskQueueServiceMock.update).toHaveBeenCalledWith("pty-1", { unattended: true });
  });

  it("explains why unattended mode is unavailable even without a backend reason", async () => {
    taskQueueServiceMock.get.mockResolvedValue(snapshot({ unattendedSupported: false }));
    await openPopover();

    expect(await screen.findByText("此 CLI 不支持无人值守审批。")).toBeInTheDocument();
  });

  it("stages an image paste as an opaque reference", async () => {
    const user = await openPopover();
    const input = await screen.findByRole("textbox", { name: /新任务|New task/i });
    const clipboardData = {
      items: [{ kind: "file", type: "image/png" }],
      getData: vi.fn(() => ""),
    } as unknown as DataTransfer;

    fireEvent.paste(input, { clipboardData });
    await waitFor(() => expect(taskQueueServiceMock.stageClipboardImage).toHaveBeenCalledWith("pty-1"));
    expect(await screen.findByText("1280 x 720")).toBeInTheDocument();

    await user.type(input, "compare{enter}");
    expect(taskQueueServiceMock.addItem).toHaveBeenCalledWith("pty-1", {
      text: "compare",
      imageRefs: ["image-1"],
    });
  });

  it("rejects an eleventh image before staging it", async () => {
    let imageNumber = 0;
    taskQueueServiceMock.stageClipboardImage.mockImplementation(async () => {
      imageNumber += 1;
      return { imageRef: `image-${imageNumber}`, width: 100, height: 100 };
    });
    await openPopover();
    const input = await screen.findByRole("textbox", { name: /新任务|New task/i });
    const clipboardData = {
      items: [{ kind: "file", type: "image/png" }],
      getData: vi.fn(() => ""),
    } as unknown as DataTransfer;

    for (let index = 1; index <= 10; index += 1) {
      fireEvent.paste(input, { clipboardData });
      await waitFor(() => {
        expect(taskQueueServiceMock.stageClipboardImage).toHaveBeenCalledTimes(index);
      });
    }
    fireEvent.paste(input, { clipboardData });

    expect(taskQueueServiceMock.stageClipboardImage).toHaveBeenCalledTimes(10);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "每个任务最多添加 10 张图片。",
    );
  });
});
