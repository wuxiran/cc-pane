export type TaskQueueState =
  | "disabled"
  | "running"
  | "paused"
  | "confirmingIdle"
  | "dispatching"
  | "actionRequired"
  | "sendFailed"
  | "sessionEnded";

export type TaskQueueReason =
  | "globalDisabled"
  | "userPaused"
  | "waitingInput"
  | "unknownPrompt"
  | "unattendedUnsupported"
  | "automaticWriteUnavailable"
  | "sessionClaimLost"
  | "sessionError"
  | "sessionExited"
  | "deliveryUnknown"
  | "submitFailed"
  | null;

export type TaskQueueItemState = "queued" | "dispatching" | "failed" | "deliveryUnknown";

export interface TaskQueueItemDraft {
  text: string;
  imageRefs: string[];
}

export interface TaskQueueControlPatch {
  paused?: boolean;
  unattended?: boolean;
}

export interface TaskQueueItem {
  id: string;
  sessionId: string;
  position: number;
  text: string;
  imageRefs: string[];
  state: TaskQueueItemState;
  createdAt: number;
  lastError: string | null;
}

export interface TaskQueueSnapshot {
  sessionId: string;
  paused: boolean;
  unattended: boolean;
  unattendedSupported: boolean;
  state: TaskQueueState;
  reason: TaskQueueReason;
  items: TaskQueueItem[];
  revision: number;
  updatedAt: number;
}

export interface StagedTaskQueueImage {
  imageRef: string;
  width: number;
  height: number;
}
