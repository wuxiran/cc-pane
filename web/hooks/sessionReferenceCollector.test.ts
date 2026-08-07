// 保护集与多实例守卫的直测（0.12.0 发版闸门 QA）。
//
// 这个模块是**两条杀链共用的唯一保护集来源**（孤儿 GC + snapshot-apply 差集杀）。
// 它的失败模式全部是「静默放大杀集」：少一路保护集不会报错，只会让本该保住的
// 会话变成候选。此前只有 useOrphanSessionReconciler 的端到端间接覆盖，分页守卫
// 的四条错误路径与 fail-closed 的五个分支一条都没被直接钉过。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_BINDING_STATUSES,
  collectReferencedSessionIdsAcrossSources,
  isSweepUnsafeForMultiClient,
} from "./sessionReferenceCollector";
import { usePanesStore } from "@/stores/usePanesStore";
import { useSelfChatStore } from "@/stores/useSelfChatStore";
import { terminalService } from "@/services/terminalService";
import { runnerService } from "@/services/runnerService";
import { taskBindingService } from "@/services/taskBindingService";
import type { TaskBinding, TaskBindingStatus } from "@/types";

vi.mock("@/stores/usePanesStore", () => ({
  usePanesStore: { getState: vi.fn() },
}));

vi.mock("@/stores/useSelfChatStore", () => ({
  useSelfChatStore: { getState: vi.fn() },
}));

vi.mock("@/services/terminalService", () => ({
  terminalService: { getDaemonClientInfo: vi.fn() },
}));

vi.mock("@/services/runnerService", () => ({
  runnerService: { listActiveInstances: vi.fn() },
}));

vi.mock("@/services/taskBindingService", () => ({
  taskBindingService: { query: vi.fn() },
}));

const PAGE_SIZE = 200;

function binding(id: string, sessionId?: string): TaskBinding {
  return { id, title: id, role: "task", status: "running", sessionId } as TaskBinding;
}

/** 每个状态各返回一页的默认桩。 */
function stubBindings(bySt: Partial<Record<TaskBindingStatus, TaskBinding[]>> = {}): void {
  vi.mocked(taskBindingService.query).mockImplementation(async (query = {}) => {
    const { status } = query;
    const items = bySt[status as TaskBindingStatus] ?? [];
    return { items, total: items.length, hasMore: false };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(usePanesStore.getState).mockReturnValue({
    collectReferencedSessionIds: () => new Set<string>(["tree-1"]),
  } as never);
  vi.mocked(useSelfChatStore.getState).mockReturnValue({ activeSession: null } as never);
  vi.mocked(runnerService.listActiveInstances).mockResolvedValue([]);
  stubBindings();
});

describe("isSweepUnsafeForMultiClient（五分支）", () => {
  it("in-process：会话为本实例独占 → 安全", async () => {
    vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({ mode: "in-process" });
    await expect(isSweepUnsafeForMultiClient("[t]")).resolves.toBe(false);
  });

  it("in-process 时不看 desktopClientCount（哪怕是 5 也安全）", async () => {
    vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({
      mode: "in-process",
      desktopClientCount: 5,
    });
    await expect(isSweepUnsafeForMultiClient("[t]")).resolves.toBe(false);
  });

  it("daemon 且计数为 1：只有本实例 → 安全", async () => {
    vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({
      mode: "daemon",
      desktopClientCount: 1,
    });
    await expect(isSweepUnsafeForMultiClient("[t]")).resolves.toBe(false);
  });

  it("daemon 且计数为 2：别的桌面实例的 tab 不可见 → 不安全", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({
      mode: "daemon",
      desktopClientCount: 2,
    });
    await expect(isSweepUnsafeForMultiClient("[t]")).resolves.toBe(true);
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it("daemon 但计数缺失（旧 daemon）→ fail-closed 不安全", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({ mode: "daemon" });
    await expect(isSweepUnsafeForMultiClient("[t]")).resolves.toBe(true);
    info.mockRestore();
  });

  it("查询抛错 → fail-closed 不安全（不得把「查不到」当成「只有我」）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(terminalService.getDaemonClientInfo).mockRejectedValue(new Error("daemon down"));
    await expect(isSweepUnsafeForMultiClient("[t]")).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("计数为 0 也判不安全（非 1 一律 fail-closed）", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.mocked(terminalService.getDaemonClientInfo).mockResolvedValue({
      mode: "daemon",
      desktopClientCount: 0,
    });
    await expect(isSweepUnsafeForMultiClient("[t]")).resolves.toBe(true);
    info.mockRestore();
  });
});

describe("LIVE_BINDING_STATUSES 穷举", () => {
  it("恰好是 pending/running/waiting 三态", () => {
    expect([...LIVE_BINDING_STATUSES].sort()).toEqual(["pending", "running", "waiting"]);
  });

  it("已结束的 completed/failed 不在其中（它们的会话不再被保护）", () => {
    expect(LIVE_BINDING_STATUSES).not.toContain("completed");
    expect(LIVE_BINDING_STATUSES).not.toContain("failed");
  });

  it("收集时逐个活跃状态各查一轮，且只查这三个", async () => {
    await collectReferencedSessionIdsAcrossSources();
    const queried = vi.mocked(taskBindingService.query).mock.calls.map(([q]) => q?.status);
    expect([...new Set(queried)].sort()).toEqual(["pending", "running", "waiting"]);
  });
});

describe("collectReferencedSessionIdsAcrossSources（保护集并集）", () => {
  it("并入树引用 + SelfChat + runner + 活跃 binding 四路来源", async () => {
    vi.mocked(useSelfChatStore.getState).mockReturnValue({
      activeSession: { id: "sc", ptySessionId: "selfchat-1" },
    } as never);
    vi.mocked(runnerService.listActiveInstances).mockResolvedValue([
      { sessionId: "runner-1" },
      { sessionId: undefined },
    ] as never);
    stubBindings({
      pending: [binding("b1", "bind-pending")],
      running: [binding("b2", "bind-running")],
      waiting: [binding("b3", "bind-waiting"), binding("b4", undefined)],
    });

    const referenced = await collectReferencedSessionIdsAcrossSources();

    expect([...referenced].sort()).toEqual([
      "bind-pending",
      "bind-running",
      "bind-waiting",
      "runner-1",
      "selfchat-1",
      "tree-1",
    ]);
  });

  it("SelfChat 无活跃会话时不并入 undefined", async () => {
    const referenced = await collectReferencedSessionIdsAcrossSources();
    expect(referenced.has("undefined")).toBe(false);
    expect([...referenced]).toEqual(["tree-1"]);
  });

  it("SelfChat 会话没有 ptySessionId 时也不并入（SelfChat 无 tabId，漏了就成孤儿）", async () => {
    vi.mocked(useSelfChatStore.getState).mockReturnValue({
      activeSession: { id: "sc", ptySessionId: undefined },
    } as never);
    const referenced = await collectReferencedSessionIdsAcrossSources();
    expect([...referenced]).toEqual(["tree-1"]);
  });

  it("runner 查询抛错 → 整体抛（fail-closed，绝不带残缺保护集返回）", async () => {
    vi.mocked(runnerService.listActiveInstances).mockRejectedValue(new Error("runner down"));
    await expect(collectReferencedSessionIdsAcrossSources()).rejects.toThrow("runner down");
  });

  it("taskBinding 查询抛错 → 整体抛", async () => {
    vi.mocked(taskBindingService.query).mockRejectedValue(new Error("binding query failed"));
    await expect(collectReferencedSessionIdsAcrossSources()).rejects.toThrow(
      "binding query failed",
    );
  });

  it("任一活跃状态的查询抛错就抛（只有 waiting 失败也不放行）", async () => {
    vi.mocked(taskBindingService.query).mockImplementation(async (query = {}) => {
      const { status } = query;
      if (status === "waiting") throw new Error("waiting page failed");
      return { items: [], total: 0, hasMore: false };
    });
    await expect(collectReferencedSessionIdsAcrossSources()).rejects.toThrow("waiting page failed");
  });
});

describe("分页守卫（四条错误路径）", () => {
  /** 只让 running 走多页，其余状态一页空。 */
  function stubRunningPages(
    pages: Array<{ items: TaskBinding[]; total: number; hasMore: boolean }>,
  ): void {
    let index = 0;
    vi.mocked(taskBindingService.query).mockImplementation(async (query = {}) => {
      const { status } = query;
      if (status !== "running") return { items: [], total: 0, hasMore: false };
      const page = pages[index] ?? { items: [], total: 0, hasMore: false };
      index += 1;
      return page;
    });
  }

  it("正常多页：逐页累加、offset 按页递增", async () => {
    const first = Array.from({ length: PAGE_SIZE }, (_, i) => binding(`b${i}`, `s${i}`));
    stubRunningPages([
      { items: first, total: PAGE_SIZE + 1, hasMore: true },
      { items: [binding("bx", "sx")], total: PAGE_SIZE + 1, hasMore: false },
    ]);

    const referenced = await collectReferencedSessionIdsAcrossSources();

    expect(referenced.has("s0")).toBe(true);
    expect(referenced.has("sx")).toBe(true);
    const offsets = vi
      .mocked(taskBindingService.query)
      .mock.calls.filter(([q]) => q?.status === "running")
      .map(([q]) => q?.offset);
    expect(offsets).toEqual([0, PAGE_SIZE]);
  });

  it("① 分页期间 total 变化 → 抛（快照撕裂，可能整页没读到）", async () => {
    stubRunningPages([
      { items: [binding("b1", "s1")], total: 2, hasMore: true },
      { items: [binding("b2", "s2")], total: 3, hasMore: false },
    ]);
    await expect(collectReferencedSessionIdsAcrossSources()).rejects.toThrow(
      /task bindings changed during running pagination/,
    );
  });

  it("② 出现重复 binding id → 抛（后端游标错位，可能漏了别的行）", async () => {
    stubRunningPages([
      { items: [binding("dup", "s1")], total: 2, hasMore: true },
      { items: [binding("dup", "s2")], total: 2, hasMore: false },
    ]);
    await expect(collectReferencedSessionIdsAcrossSources()).rejects.toThrow(
      /duplicate task binding during running pagination: dup/,
    );
  });

  it("③ hasMore=true 却给了空页 → 抛（否则 offset 永远推进不动/死循环）", async () => {
    stubRunningPages([
      { items: [binding("b1", "s1")], total: 5, hasMore: true },
      { items: [], total: 5, hasMore: true },
    ]);
    await expect(collectReferencedSessionIdsAcrossSources()).rejects.toThrow(
      /empty task binding page for running at offset 200/,
    );
  });

  it("④ 收尾时计数与 total 不等 → 抛（读到的行数少于后端声明）", async () => {
    stubRunningPages([{ items: [binding("b1", "s1")], total: 7, hasMore: false }]);
    await expect(collectReferencedSessionIdsAcrossSources()).rejects.toThrow(
      /incomplete task binding pagination for running: expected 7, got 1/,
    );
  });

  it("total=0 的空结果正常收尾，不抛", async () => {
    stubRunningPages([{ items: [], total: 0, hasMore: false }]);
    await expect(collectReferencedSessionIdsAcrossSources()).resolves.toBeInstanceOf(Set);
  });

  it("binding 无 sessionId 时不进保护集，但仍计入行数校验", async () => {
    stubRunningPages([
      { items: [binding("b1", undefined), binding("b2", "s2")], total: 2, hasMore: false },
    ]);
    const referenced = await collectReferencedSessionIdsAcrossSources();
    expect([...referenced].sort()).toEqual(["s2", "tree-1"]);
  });
});
