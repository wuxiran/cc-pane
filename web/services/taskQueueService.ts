import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listenIfTauri } from "@/services/runtime";
import type {
  StagedTaskQueueImage,
  TaskQueueControlPatch,
  TaskQueueItemDraft,
  TaskQueueSnapshot,
} from "@/types/taskQueue";
import { isTauriRuntime } from "./runtime";

export class TaskQueueUnavailableError extends Error {
  readonly code = "UNAVAILABLE";

  constructor() {
    super("Task queue is only available in the desktop app");
    this.name = "TaskQueueUnavailableError";
  }
}

function requireDesktop(): void {
  if (!isTauriRuntime()) throw new TaskQueueUnavailableError();
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  requireDesktop();
  return invoke<T>(command, args);
}

export type TaskQueueSnapshotHandler = (snapshot: TaskQueueSnapshot) => void | Promise<void>;

export const taskQueueService = {
  get(sessionId: string): Promise<TaskQueueSnapshot> {
    return call("get_terminal_task_queue", { sessionId });
  },

  stageClipboardImage(sessionId: string): Promise<StagedTaskQueueImage> {
    return call("stage_terminal_task_queue_clipboard_image", { sessionId });
  },

  addItem(sessionId: string, draft: TaskQueueItemDraft): Promise<TaskQueueSnapshot> {
    return call("add_terminal_task_queue_item", { sessionId, draft });
  },

  deleteItem(sessionId: string, itemId: string): Promise<TaskQueueSnapshot> {
    return call("delete_terminal_task_queue_item", { sessionId, itemId });
  },

  clear(sessionId: string): Promise<TaskQueueSnapshot> {
    return call("clear_terminal_task_queue", { sessionId });
  },

  update(sessionId: string, patch: TaskQueueControlPatch): Promise<TaskQueueSnapshot> {
    return call("update_terminal_task_queue", { sessionId, patch });
  },

  retry(sessionId: string, itemId: string): Promise<TaskQueueSnapshot> {
    return call("retry_terminal_task_queue_item", { sessionId, itemId });
  },

  async subscribe(handler: TaskQueueSnapshotHandler): Promise<UnlistenFn> {
    requireDesktop();
    return listenIfTauri<TaskQueueSnapshot>("task-queue-updated", (event) => handler(event.payload));
  },
};
