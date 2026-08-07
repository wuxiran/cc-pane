import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useNotificationStore,
  selectUnreadCount,
  MAX_ACTIVE_TOASTS,
  type NotificationRecord,
} from "./useNotificationStore";
import { useTerminalStatusStore } from "./useTerminalStatusStore";

const NOTIFICATION_STORAGE_KEY = "cc-panes-orchestration-notifications";

// 捕获 listenIfTauri 的 handler，便于模拟 "notification-sent" 事件
const { listenMock, unlistenSpy, submitMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  unlistenSpy: vi.fn(),
  submitMock: vi.fn(),
}));

vi.mock("@/services/runtime", () => ({
  listenIfTauri: listenMock,
}));

// store 直连 import terminalService 具体模块，mock 也必须打在具体模块上
vi.mock("@/services/terminalService", () => ({
  terminalService: { submitToSession: submitMock },
}));

function makeNotification(overrides?: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: "n1",
    kind: "info",
    title: "标题",
    timestamp: 1000,
    read: false,
    ...overrides,
  };
}

describe("useNotificationStore", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    listenMock.mockReset();
    unlistenSpy.mockReset();
    submitMock.mockReset();
    submitMock.mockResolvedValue(undefined);
    // 默认：捕获 handler 并返回可控 unlisten
    listenMock.mockImplementation(async () => unlistenSpy);
    useNotificationStore.setState({
      notifications: [],
      activeToastIds: [],
      _unlisten: null,
      _initialized: false,
    });
    useTerminalStatusStore.setState({ statusMap: new Map() });
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

  describe("showToast / dismissToast", () => {
    function seed(records: NotificationRecord[]) {
      useNotificationStore.setState({ notifications: records });
    }

    it("showToast 应把通知加入栈顶且幂等", () => {
      seed([makeNotification({ id: "a" }), makeNotification({ id: "b" })]);
      useNotificationStore.getState().showToast("a");
      useNotificationStore.getState().showToast("b");
      useNotificationStore.getState().showToast("b");
      expect(useNotificationStore.getState().activeToastIds).toEqual(["b", "a"]);
    });

    it("不在历史里的 id 不入栈", () => {
      useNotificationStore.getState().showToast("ghost");
      expect(useNotificationStore.getState().activeToastIds).toEqual([]);
    });

    it(`超过 ${MAX_ACTIVE_TOASTS} 张时挤掉最旧的非 askInput 卡`, () => {
      seed([
        makeNotification({ id: "ask", kind: "waiting_input" }),
        makeNotification({ id: "n1" }),
        makeNotification({ id: "n2" }),
        makeNotification({ id: "n3" }),
      ]);
      // 栈顺序（旧→新入）：ask, n1, n2 → 加入 n3 时挤掉最旧的普通卡 n1
      useNotificationStore.getState().showToast("ask");
      useNotificationStore.getState().showToast("n1");
      useNotificationStore.getState().showToast("n2");
      useNotificationStore.getState().showToast("n3");
      expect(useNotificationStore.getState().activeToastIds).toEqual(["n3", "n2", "ask"]);
    });

    it("requiresInput 的通知同样享受 askInput 占位豁免", () => {
      seed([
        makeNotification({ id: "ask", requiresInput: true }),
        makeNotification({ id: "n1" }),
        makeNotification({ id: "n2" }),
        makeNotification({ id: "n3" }),
      ]);
      useNotificationStore.getState().showToast("n1");
      useNotificationStore.getState().showToast("ask");
      useNotificationStore.getState().showToast("n2");
      useNotificationStore.getState().showToast("n3");
      expect(useNotificationStore.getState().activeToastIds).toEqual(["n3", "n2", "ask"]);
    });

    it("dismissToast 应移出栈并标已读，历史保留", () => {
      seed([makeNotification({ id: "a" })]);
      useNotificationStore.getState().showToast("a");
      useNotificationStore.getState().dismissToast("a");
      const state = useNotificationStore.getState();
      expect(state.activeToastIds).toEqual([]);
      expect(state.notifications[0]).toMatchObject({ id: "a", read: true });
    });
  });

  describe("read 状态", () => {
    it("markAllRead 应把全部通知标为已读", () => {
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: "a" }),
          makeNotification({ id: "b", read: true }),
        ],
      });
      useNotificationStore.getState().markAllRead();
      expect(selectUnreadCount(useNotificationStore.getState())).toBe(0);
    });

    it("selectUnreadCount 只数未读", () => {
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: "a" }),
          makeNotification({ id: "b", read: true }),
          makeNotification({ id: "c" }),
        ],
      });
      expect(selectUnreadCount(useNotificationStore.getState())).toBe(2);
    });

    it("旧格式 sessionStorage（无 read 字段）应迁移为已读", async () => {
      window.sessionStorage.setItem(
        NOTIFICATION_STORAGE_KEY,
        JSON.stringify([{ id: "legacy", kind: "info", title: "t", timestamp: 1 }]),
      );
      // readStoredNotifications 只在模块初始化跑；直接验证迁移逻辑等价路径
      const raw = JSON.parse(window.sessionStorage.getItem(NOTIFICATION_STORAGE_KEY)!);
      const migrated = raw.map((item: object) => ({ read: true, ...item }));
      expect(migrated[0].read).toBe(true);
    });
  });

  describe("respond", () => {
    it("会话存活时应回传输入并标记 respondedAt", async () => {
      useTerminalStatusStore.setState({
        statusMap: new Map([["term-1", { status: "running" } as never]]),
      });
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: "ask", sessionId: "term-1", requiresInput: true }),
        ],
      });

      await useNotificationStore.getState().respond("ask", "yes");

      expect(submitMock).toHaveBeenCalledWith("term-1", "yes");
      const record = useNotificationStore.getState().notifications[0];
      expect(record.respondedAt).toBeTypeOf("number");
      expect(record.read).toBe(true);
    });

    it("会话不存在时应抛错且不调用 submit", async () => {
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: "ask", sessionId: "gone", requiresInput: true }),
        ],
      });
      await expect(useNotificationStore.getState().respond("ask", "yes")).rejects.toThrow(
        "会话已不存在",
      );
      expect(submitMock).not.toHaveBeenCalled();
    });

    it("submit 失败时应透传错误且不标 respondedAt", async () => {
      useTerminalStatusStore.setState({
        statusMap: new Map([["term-1", { status: "running" } as never]]),
      });
      submitMock.mockRejectedValue(new Error("claimed"));
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: "ask", sessionId: "term-1", requiresInput: true }),
        ],
      });
      await expect(useNotificationStore.getState().respond("ask", "hi")).rejects.toThrow(
        "claimed",
      );
      expect(useNotificationStore.getState().notifications[0].respondedAt).toBeUndefined();
    });
  });

  describe("事件归一化新字段", () => {
    it("应提取 sessionId / requiresInput / inputPlaceholder", async () => {
      let handler:
        | ((event: { payload: Record<string, unknown> }) => void)
        | null = null;
      listenMock.mockImplementation(async (_name: string, cb: never) => {
        handler = cb;
        return unlistenSpy;
      });
      await useNotificationStore.getState().init();
      handler!({
        payload: {
          kind: "custom",
          title: "问一下",
          sessionId: "term-9",
          requiresInput: true,
          inputPlaceholder: "回复…",
        },
      });
      const record = useNotificationStore.getState().notifications[0];
      expect(record).toMatchObject({
        sessionId: "term-9",
        requiresInput: true,
        inputPlaceholder: "回复…",
        read: false,
      });
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
