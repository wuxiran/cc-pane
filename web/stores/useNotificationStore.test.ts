import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useNotificationStore,
  type NotificationRecord,
} from "./useNotificationStore";

const NOTIFICATION_STORAGE_KEY = "cc-panes-orchestration-notifications";

// 捕获 listenIfTauri 的 handler，便于模拟 "notification-sent" 事件
const { listenMock, unlistenSpy } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  unlistenSpy: vi.fn(),
}));

vi.mock("@/services/runtime", () => ({
  listenIfTauri: listenMock,
}));

function makeNotification(overrides?: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: "n1",
    kind: "info",
    title: "标题",
    timestamp: 1000,
    ...overrides,
  };
}

describe("useNotificationStore", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    listenMock.mockReset();
    unlistenSpy.mockReset();
    // 默认：捕获 handler 并返回可控 unlisten
    listenMock.mockImplementation(async () => unlistenSpy);
    useNotificationStore.setState({
      notifications: [],
      _unlisten: null,
      _initialized: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("初始状态", () => {
    it("应有空的通知列表且未初始化", () => {
      const state = useNotificationStore.getState();
      expect(state.notifications).toEqual([]);
      expect(state._unlisten).toBeNull();
      expect(state._initialized).toBe(false);
    });
  });

  describe("add", () => {
    it("应将新通知放到列表最前面", () => {
      const first = makeNotification({ id: "a" });
      const second = makeNotification({ id: "b" });

      useNotificationStore.getState().add(first);
      useNotificationStore.getState().add(second);

      const { notifications } = useNotificationStore.getState();
      expect(notifications.map((n) => n.id)).toEqual(["b", "a"]);
    });

    it("应将通知持久化到 sessionStorage", () => {
      useNotificationStore.getState().add(makeNotification({ id: "persist" }));

      const raw = window.sessionStorage.getItem(NOTIFICATION_STORAGE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw as string);
      expect(parsed[0].id).toBe("persist");
    });

    it("超过 100 条时应截断为最新的 100 条", () => {
      const initial = Array.from({ length: 100 }, (_, i) =>
        makeNotification({ id: `old-${i}` }),
      );
      useNotificationStore.setState({ notifications: initial });

      useNotificationStore.getState().add(makeNotification({ id: "newest" }));

      const { notifications } = useNotificationStore.getState();
      expect(notifications).toHaveLength(100);
      expect(notifications[0].id).toBe("newest");
      expect(notifications.some((n) => n.id === "old-99")).toBe(false);
    });
  });

  describe("clear", () => {
    it("应清空内存列表与 sessionStorage", () => {
      useNotificationStore.setState({
        notifications: [makeNotification()],
      });
      window.sessionStorage.setItem(NOTIFICATION_STORAGE_KEY, "[{}]");

      useNotificationStore.getState().clear();

      expect(useNotificationStore.getState().notifications).toEqual([]);
      expect(window.sessionStorage.getItem(NOTIFICATION_STORAGE_KEY)).toBe("[]");
    });
  });

  describe("init", () => {
    it("应注册监听器并标记为已初始化", async () => {
      await useNotificationStore.getState().init();

      expect(listenMock).toHaveBeenCalledTimes(1);
      expect(listenMock).toHaveBeenCalledWith(
        "notification-sent",
        expect.any(Function),
      );
      const state = useNotificationStore.getState();
      expect(state._initialized).toBe(true);
      expect(state._unlisten).toBe(unlistenSpy);
    });

    it("重复调用 init 应保持幂等（只注册一次）", async () => {
      await useNotificationStore.getState().init();
      await useNotificationStore.getState().init();

      expect(listenMock).toHaveBeenCalledTimes(1);
    });

    it("收到 notification-sent 事件时应归一化并加入列表", async () => {
      let handler:
        | ((event: { payload: Record<string, unknown> }) => void)
        | null = null;
      listenMock.mockImplementation(async (_name: string, cb: never) => {
        handler = cb;
        return unlistenSpy;
      });

      await useNotificationStore.getState().init();
      expect(handler).toBeTypeOf("function");

      handler!({
        payload: {
          id: "evt-1",
          kind: "warning",
          title: "警告",
          body: "内容",
          timestamp: 42,
        },
      });

      const { notifications } = useNotificationStore.getState();
      expect(notifications[0]).toMatchObject({
        id: "evt-1",
        kind: "warning",
        title: "警告",
        body: "内容",
        timestamp: 42,
      });
    });

    it("事件缺省字段时应使用默认值归一化", async () => {
      let handler:
        | ((event: { payload: Record<string, unknown> }) => void)
        | null = null;
      listenMock.mockImplementation(async (_name: string, cb: never) => {
        handler = cb;
        return unlistenSpy;
      });

      await useNotificationStore.getState().init();
      handler!({ payload: {} });

      const record = useNotificationStore.getState().notifications[0];
      expect(record.id).toBeTruthy();
      expect(record.kind).toBe("notification");
      expect(record.title).toBe("Notification");
      expect(typeof record.timestamp).toBe("number");
    });

    it("应从 metadata 中回退提取 taskBindingId", async () => {
      let handler:
        | ((event: { payload: Record<string, unknown> }) => void)
        | null = null;
      listenMock.mockImplementation(async (_name: string, cb: never) => {
        handler = cb;
        return unlistenSpy;
      });

      await useNotificationStore.getState().init();
      handler!({
        payload: { metadata: { task_binding_id: "tb-9" } },
      });

      expect(useNotificationStore.getState().notifications[0].taskBindingId).toBe(
        "tb-9",
      );
    });
  });

  describe("cleanup", () => {
    it("应调用 unlisten 并重置初始化状态", async () => {
      await useNotificationStore.getState().init();

      useNotificationStore.getState().cleanup();

      expect(unlistenSpy).toHaveBeenCalledTimes(1);
      const state = useNotificationStore.getState();
      expect(state._unlisten).toBeNull();
      expect(state._initialized).toBe(false);
    });

    it("未初始化时 cleanup 不应抛错", () => {
      expect(() => useNotificationStore.getState().cleanup()).not.toThrow();
    });
  });
});
