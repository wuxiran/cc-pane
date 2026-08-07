// 后台布局恢复的槽位与回滚（0.12.0 发版闸门 QA）。
//
// useTerminalSessionRestore.test.ts 已覆盖「逐 leaf 恢复」与「出队重检」两条主路径，
// 本文件补的是失败/竞态路径——它们的坏法都不会报错：
// - 槽位被占时若照样 create，同一格会真的多起一个 PTY；
// - create 抛错时若不 release，该 (tabId, paneId) **永久**再也建不出会话
//   （槽位是模块级 Set，没有超时回收）；
// - 创建后复查失败时若不按 sessionId 相等判定，会把刚认领回来的**同一条**
//   活会话当成重复 PTY 杀掉。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBackgroundLayoutRestore } from "./backgroundLayoutRestore";
import { usePanesStore, useTerminalStatusStore } from "@/stores";
import { terminalService } from "@/services";
import {
  acquireTerminalSlot,
  inFlightSlotCount,
  resetTerminalSlots,
} from "@/lib/terminalSlot";

vi.mock("@/stores", () => ({
  usePanesStore: { getState: vi.fn() },
  useTerminalStatusStore: { getState: vi.fn() },
}));

vi.mock("@/services", () => ({
  terminalService: {
    createSession: vi.fn(),
    killSession: vi.fn(),
  },
}));

vi.mock("@/components/panes/terminalRestoreQueue", () => ({
  terminalRestoreLaunchQueue: {
    run: (task: () => Promise<unknown>) => task(),
    getSnapshot: () => ({ active: 0, pending: 0 }),
  },
}));

const markSessionLive = vi.fn();
const setBackgroundRestoreSession = vi.fn();
const updateTerminalLaunchId = vi.fn();

interface StateOverrides {
  canCreateTerminalSession?: (...args: unknown[]) => boolean;
  leaf?: Record<string, unknown>;
}

function mockState(overrides: StateOverrides = {}): void {
  const leaf = {
    type: "leaf",
    id: "leaf-1",
    sessionId: null,
    cliTool: "claude",
    ...overrides.leaf,
  };
  vi.mocked(usePanesStore.getState).mockReturnValue({
    currentLayoutId: "current",
    getRestorableTabs: () => [{
      layoutId: "other",
      tab: {
        id: "tab-1",
        contentType: "terminal",
        projectPath: "/p",
        terminalRootPane: leaf,
      },
    }],
    setBackgroundRestoreSession,
    updateTerminalLaunchId,
    canCreateTerminalSession: overrides.canCreateTerminalSession ?? (() => true),
  } as never);
}

/** 队列是直通的，但 create 之后还有若干微任务。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTerminalSlots();
  vi.mocked(useTerminalStatusStore.getState).mockReturnValue({
    markSessionLive,
    statusMap: new Map(),
  } as never);
  vi.mocked(terminalService.killSession).mockResolvedValue(undefined);
});

describe("槽位（同进程并发挡在 spawn 之前）", () => {
  it("槽位已被占时不 create（否则同一格会真的多起一个 PTY）", async () => {
    mockState();
    const held = acquireTerminalSlot("tab-1", "leaf-1");
    expect(held).not.toBeNull();

    await runBackgroundLayoutRestore();
    await flush();

    expect(terminalService.createSession).not.toHaveBeenCalled();
    expect(setBackgroundRestoreSession).not.toHaveBeenCalled();
  });

  it("成功路径结束后槽位归还（否则同一格再也建不出会话）", async () => {
    mockState();
    vi.mocked(terminalService.createSession).mockResolvedValue("new-session");

    await runBackgroundLayoutRestore();
    await flush();

    expect(setBackgroundRestoreSession).toHaveBeenCalledWith("tab-1", "leaf-1", "new-session");
    expect(inFlightSlotCount()).toBe(0);
  });

  it("create 抛错时槽位仍归还（槽是模块级 Set，泄漏 = 永久锁死该格）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockState();
    vi.mocked(terminalService.createSession).mockRejectedValue(new Error("spawn failed"));

    await runBackgroundLayoutRestore();
    await flush();

    expect(inFlightSlotCount()).toBe(0);
    // 归还之后同一格可以再次占坑
    expect(acquireTerminalSlot("tab-1", "leaf-1")).not.toBeNull();
    warn.mockRestore();
  });

  it("create 抛错不外抛（fire-and-forget：一格失败不拖垮整轮恢复）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockState();
    vi.mocked(terminalService.createSession).mockRejectedValue(new Error("spawn failed"));

    await expect(runBackgroundLayoutRestore()).resolves.toBeUndefined();
    await flush();

    expect(setBackgroundRestoreSession).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("创建后复查失败也归还槽位", async () => {
    mockState({
      // 出队前放行、创建后复查拒绝
      canCreateTerminalSession: (() => {
        let call = 0;
        return () => {
          call += 1;
          return call === 1;
        };
      })(),
    });
    vi.mocked(terminalService.createSession).mockResolvedValue("dup-session");

    await runBackgroundLayoutRestore();
    await flush();

    expect(inFlightSlotCount()).toBe(0);
  });
});

describe("创建后复查回滚", () => {
  function rejectAfterCreate() {
    let call = 0;
    return () => {
      call += 1;
      return call === 1;
    };
  }

  it("复查失败且是新建的 PTY → kill（回滚重复会话）", async () => {
    mockState({ canCreateTerminalSession: rejectAfterCreate() });
    vi.mocked(terminalService.createSession).mockResolvedValue("dup-session");

    await runBackgroundLayoutRestore();
    await flush();

    expect(terminalService.killSession).toHaveBeenCalledWith("dup-session");
    expect(setBackgroundRestoreSession).not.toHaveBeenCalled();
    expect(markSessionLive).not.toHaveBeenCalled();
  });

  it("复查失败但 sessionId 等于 expectedSavedSessionId → **不 kill**（那是认领回来的同一条活会话）", async () => {
    mockState({
      leaf: { savedSessionId: "saved-1" },
      canCreateTerminalSession: rejectAfterCreate(),
    });
    vi.mocked(terminalService.createSession).mockResolvedValue("saved-1");

    await runBackgroundLayoutRestore();
    await flush();

    expect(terminalService.killSession).not.toHaveBeenCalled();
    expect(setBackgroundRestoreSession).not.toHaveBeenCalled();
  });

  it("复查通过时不 kill，且先 markSessionLive 再落 store", async () => {
    const order: string[] = [];
    markSessionLive.mockImplementation(() => order.push("markLive"));
    setBackgroundRestoreSession.mockImplementation(() => order.push("setSession"));
    mockState();
    vi.mocked(terminalService.createSession).mockResolvedValue("new-session");

    await runBackgroundLayoutRestore();
    await flush();

    expect(terminalService.killSession).not.toHaveBeenCalled();
    expect(order).toEqual(["markLive", "setSession"]);
  });

  it("kill 失败被吞掉，不冒泡成未处理拒绝", async () => {
    mockState({ canCreateTerminalSession: rejectAfterCreate() });
    vi.mocked(terminalService.createSession).mockResolvedValue("dup-session");
    vi.mocked(terminalService.killSession).mockRejectedValue(new Error("daemon down"));

    await expect(runBackgroundLayoutRestore()).resolves.toBeUndefined();
    await flush();
    expect(inFlightSlotCount()).toBe(0);
  });
});

describe("调度过滤", () => {
  it("零目标时直接返回，不碰队列（当前布局 / 已有会话 / 已阻断）", async () => {
    vi.mocked(usePanesStore.getState).mockReturnValue({
      currentLayoutId: "current",
      getRestorableTabs: () => [
        // 当前布局由已挂载的 TerminalView 负责
        {
          layoutId: "current",
          tab: {
            id: "t-cur",
            contentType: "terminal",
            projectPath: "/p",
            terminalRootPane: { type: "leaf", id: "l", sessionId: null },
          },
        },
        // 已有会话
        {
          layoutId: "other",
          tab: {
            id: "t-live",
            contentType: "terminal",
            projectPath: "/p",
            terminalRootPane: { type: "leaf", id: "l", sessionId: "live" },
          },
        },
        // 已被阻断（等用户处置，不得自动重建）
        {
          layoutId: "other",
          tab: {
            id: "t-blocked",
            contentType: "terminal",
            projectPath: "/p",
            terminalRootPane: {
              type: "leaf",
              id: "l",
              sessionId: null,
              restoreBlockedReason: "claim-conflict",
            },
          },
        },
        // 非终端
        { layoutId: "other", tab: { id: "t-editor", contentType: "editor", projectPath: "/p" } },
        // 无 projectPath（不会启动 PTY）
        {
          layoutId: "other",
          tab: {
            id: "t-nopath",
            contentType: "terminal",
            projectPath: "",
            terminalRootPane: { type: "leaf", id: "l", sessionId: null },
          },
        },
      ],
      setBackgroundRestoreSession,
      updateTerminalLaunchId,
      canCreateTerminalSession: () => true,
    } as never);

    await runBackgroundLayoutRestore();
    await flush();

    expect(terminalService.createSession).not.toHaveBeenCalled();
    expect(inFlightSlotCount()).toBe(0);
  });

  it("savedSessionId 仍活着时跳过（会话还在，等认领而不是重建）", async () => {
    vi.mocked(useTerminalStatusStore.getState).mockReturnValue({
      markSessionLive,
      statusMap: new Map([
        ["saved-live", { sessionId: "saved-live", status: "idle", lastOutputAt: 0, updatedAt: 0 }],
      ]),
    } as never);
    mockState({ leaf: { savedSessionId: "saved-live" } });

    await runBackgroundLayoutRestore();
    await flush();

    expect(terminalService.createSession).not.toHaveBeenCalled();
  });

  it("savedSessionId 已退出时照常重建", async () => {
    vi.mocked(useTerminalStatusStore.getState).mockReturnValue({
      markSessionLive,
      statusMap: new Map([
        ["saved-dead", { sessionId: "saved-dead", status: "exited", lastOutputAt: 0, updatedAt: 0 }],
      ]),
    } as never);
    mockState({ leaf: { savedSessionId: "saved-dead" } });
    vi.mocked(terminalService.createSession).mockResolvedValue("fresh");

    await runBackgroundLayoutRestore();
    await flush();

    expect(terminalService.createSession).toHaveBeenCalledTimes(1);
    expect(terminalService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSavedSessionId: "saved-dead" }),
    );
  });

  it("launchId 每次新生成且先落 store 再 create（docs/69：绝不复用 projectId）", async () => {
    mockState();
    vi.mocked(terminalService.createSession).mockResolvedValue("new-session");

    await runBackgroundLayoutRestore();
    await flush();

    const [[args]] = vi.mocked(terminalService.createSession).mock.calls;
    const launchId = (args as { launchId: string }).launchId;
    expect(launchId).toMatch(/^launch-/);
    expect(launchId).not.toBe("tab-1");
    expect(updateTerminalLaunchId).toHaveBeenCalledWith("tab-1", "leaf-1", launchId);
    expect(
      vi.mocked(updateTerminalLaunchId).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(terminalService.createSession).mock.invocationCallOrder[0]);
  });

  it("create 参数按 leaf 优先、tab 兜底取（分屏各格可有各自的启动身份）", async () => {
    vi.mocked(usePanesStore.getState).mockReturnValue({
      currentLayoutId: "current",
      getRestorableTabs: () => [{
        layoutId: "other",
        tab: {
          id: "tab-1",
          contentType: "terminal",
          projectPath: "/p",
          cliTool: "claude",
          resumeId: "tab-resume",
          workspaceName: "tab-ws",
          terminalRootPane: {
            type: "leaf",
            id: "leaf-1",
            sessionId: null,
            cliTool: "codex",
            resumeId: "leaf-resume",
          },
        },
      }],
      setBackgroundRestoreSession,
      updateTerminalLaunchId,
      canCreateTerminalSession: () => true,
    } as never);
    vi.mocked(terminalService.createSession).mockResolvedValue("s");

    await runBackgroundLayoutRestore();
    await flush();

    expect(terminalService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cliTool: "codex",
        resumeId: "leaf-resume",
        workspaceName: "tab-ws",
        originLayoutId: "other",
        originTabId: "tab-1",
        originTerminalPaneId: "leaf-1",
      }),
    );
  });
});
