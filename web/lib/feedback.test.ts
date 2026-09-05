import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOASTER_OFFSET_CCCHAN,
  TOASTER_OFFSET_MAIN,
  TOASTER_POSITION,
  TOAST_DURATION_ERR,
  TOAST_DURATION_INFO,
  TOAST_DURATION_OK,
  TOAST_DURATION_WARN,
  notifyAsync,
  toastErr,
  toastInfo,
  toastOk,
  toastWarn,
} from "./feedback";
import { useNotificationStore } from "@/stores/useNotificationStore";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(() => 1),
    info: vi.fn(() => 2),
    warning: vi.fn(() => 3),
    error: vi.fn(() => 4),
  },
}));

import { toast } from "sonner";

describe("feedback toast wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toaster placement stays bottom-center with offsets above StatusBar", () => {
    expect(TOASTER_POSITION).toBe("bottom-center");
    // StatusBar h-[28px] + 1px 边框，offset 必须大于 29 才不会压住
    expect(TOASTER_OFFSET_MAIN.bottom).toBeGreaterThan(29);
    expect(TOASTER_OFFSET_CCCHAN.bottom).toBeGreaterThan(0);
  });

  it("keeps duration ordering: ok < info < warn < err", () => {
    expect(TOAST_DURATION_OK).toBeLessThan(TOAST_DURATION_INFO);
    expect(TOAST_DURATION_INFO).toBeLessThan(TOAST_DURATION_WARN);
    expect(TOAST_DURATION_WARN).toBeLessThan(TOAST_DURATION_ERR);
  });

  it("toastOk routes to sonner success with unified duration", () => {
    toastOk("saved");
    expect(toast.success).toHaveBeenCalledWith("saved", { duration: TOAST_DURATION_OK });
  });

  it("toastInfo/toastWarn/toastErr route to matching sonner variants", () => {
    toastInfo("hint");
    toastWarn("careful");
    toastErr("boom");
    expect(toast.info).toHaveBeenCalledWith("hint", { duration: TOAST_DURATION_INFO });
    expect(toast.warning).toHaveBeenCalledWith("careful", { duration: TOAST_DURATION_WARN });
    expect(toast.error).toHaveBeenCalledWith("boom", { duration: TOAST_DURATION_ERR });
  });

  it("caller options can override default duration", () => {
    toastErr("boom", { duration: 10_000, id: "x" });
    expect(toast.error).toHaveBeenCalledWith("boom", { duration: 10_000, id: "x" });
  });
});

describe("notifyAsync", () => {
  beforeEach(() => {
    useNotificationStore.getState().clear();
  });

  it("adds to history and shows a card by default", () => {
    const id = notifyAsync({ title: "任务完成", kind: "task_completed" });
    const state = useNotificationStore.getState();
    expect(state.notifications.some((n) => n.id === id)).toBe(true);
    expect(state.activeToastIds).toContain(id);
    expect(state.notifications.find((n) => n.id === id)?.kind).toBe("task_completed");
  });

  it("showCard:false only records history without popping a card", () => {
    const id = notifyAsync({ title: "静默事件", showCard: false });
    const state = useNotificationStore.getState();
    expect(state.notifications.some((n) => n.id === id)).toBe(true);
    expect(state.activeToastIds).not.toContain(id);
  });

  it("passes requiresInput through to the record", () => {
    const id = notifyAsync({ title: "等待输入", kind: "waiting_input", requiresInput: true });
    const record = useNotificationStore.getState().notifications.find((n) => n.id === id);
    expect(record?.requiresInput).toBe(true);
  });
});
