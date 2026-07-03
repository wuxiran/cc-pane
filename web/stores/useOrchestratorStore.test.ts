import { describe, it, expect, beforeEach, vi } from "vitest";
import { useOrchestratorStore } from "./useOrchestratorStore";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import type {
  TaskBinding,
  TaskBindingQueryResult,
} from "@/types";

const SELECTED_TASK_STORAGE_KEY = "cc-panes-orchestration-selected-task-id";

let bindingCounter = 0;

function createTestBinding(overrides?: Partial<TaskBinding>): TaskBinding {
  bindingCounter += 1;
  const id = `binding-${bindingCounter}`;
  const now = new Date().toISOString();
  return {
    id,
    title: `task ${id}`,
    role: "task",
    projectPath: "/tmp/project",
    cliTool: "claude",
    status: "pending",
    progress: 0,
    sortOrder: bindingCounter,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function queryResult(items: TaskBinding[]): TaskBindingQueryResult {
  return { items, total: items.length, hasMore: false };
}

/** 等待 store 内未 await 的异步 loadBindings 完成 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function resetStore(): void {
  useOrchestratorStore.setState({
    bindings: [],
    total: 0,
    hasMore: false,
    loading: false,
    filterTab: "all",
    filterWorkspace: null,
    filterProjectPath: null,
    filterRole: null,
    searchKeyword: "",
    lastTargetProjectPath: null,
    viewType: "list",
    selectedTaskId: null,
  });
}

describe("useOrchestratorStore", () => {
  beforeEach(() => {
    resetTauriInvoke();
    bindingCounter = 0;
    window.sessionStorage.clear();
    resetStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("初始状态", () => {
    it("应有正确的初始值", () => {
      const state = useOrchestratorStore.getState();
      expect(state.bindings).toEqual([]);
      expect(state.total).toBe(0);
      expect(state.hasMore).toBe(false);
      expect(state.loading).toBe(false);
      expect(state.filterTab).toBe("all");
      expect(state.filterWorkspace).toBeNull();
      expect(state.filterProjectPath).toBeNull();
      expect(state.filterRole).toBeNull();
      expect(state.searchKeyword).toBe("");
      expect(state.viewType).toBe("list");
    });
  });

  describe("loadBindings", () => {
    it("应加载 bindings 并写入 total / hasMore", async () => {
      const items = [createTestBinding(), createTestBinding()];
      mockTauriInvoke({
        query_task_bindings: { items, total: 5, hasMore: true },
      });

      await useOrchestratorStore.getState().loadBindings();

      const state = useOrchestratorStore.getState();
      expect(state.bindings).toEqual(items);
      expect(state.total).toBe(5);
      expect(state.hasMore).toBe(true);
      expect(state.loading).toBe(false);
    });

    it("加载期间应设置 loading 为 true", async () => {
      mockTauriInvoke({
        query_task_bindings: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(queryResult([])), 10)
          ),
      });

      const promise = useOrchestratorStore.getState().loadBindings();
      expect(useOrchestratorStore.getState().loading).toBe(true);

      await promise;
      expect(useOrchestratorStore.getState().loading).toBe(false);
    });

    it("加载失败时应重置 loading 且不抛出", async () => {
      mockTauriInvoke({
        query_task_bindings: () => {
          throw new Error("查询失败");
        },
      });

      await useOrchestratorStore.getState().loadBindings();

      expect(useOrchestratorStore.getState().loading).toBe(false);
    });

    it("加载后若已选中任务不在结果中应回退到首个", async () => {
      const items = [createTestBinding(), createTestBinding()];
      useOrchestratorStore.setState({ selectedTaskId: "not-exist" });
      mockTauriInvoke({ query_task_bindings: queryResult(items) });

      await useOrchestratorStore.getState().loadBindings();

      expect(useOrchestratorStore.getState().selectedTaskId).toBe(items[0].id);
    });
  });

  describe("create", () => {
    it("应创建并重新加载列表，返回创建的 binding", async () => {
      const created = createTestBinding({ title: "新任务" });
      mockTauriInvoke({
        create_task_binding: created,
        query_task_bindings: queryResult([created]),
      });

      const result = await useOrchestratorStore
        .getState()
        .create({ title: "新任务", projectPath: "/tmp/project" });

      expect(result).toEqual(created);
      expect(useOrchestratorStore.getState().bindings).toEqual([created]);
    });
  });

  describe("update", () => {
    it("应更新并重新加载列表", async () => {
      const updated = createTestBinding({ title: "改后" });
      mockTauriInvoke({
        update_task_binding: updated,
        query_task_bindings: queryResult([updated]),
      });

      const result = await useOrchestratorStore
        .getState()
        .update(updated.id, { title: "改后" });

      expect(result).toEqual(updated);
      expect(useOrchestratorStore.getState().bindings).toEqual([updated]);
    });
  });

  describe("updatePatch", () => {
    it("应就地替换已存在的 binding", async () => {
      const binding = createTestBinding();
      useOrchestratorStore.setState({ bindings: [binding] });
      const patched = { ...binding, progress: 50 };
      mockTauriInvoke({ update_task_binding_patch: patched });

      const result = await useOrchestratorStore
        .getState()
        .updatePatch(binding.id, { progress: 50 });

      expect(result).toEqual(patched);
      expect(useOrchestratorStore.getState().bindings).toEqual([patched]);
    });

    it("对不存在的 binding 应前插入列表", async () => {
      const existing = createTestBinding();
      useOrchestratorStore.setState({ bindings: [existing] });
      const fresh = createTestBinding();
      mockTauriInvoke({ update_task_binding_patch: fresh });

      await useOrchestratorStore.getState().updatePatch(fresh.id, {});

      expect(useOrchestratorStore.getState().bindings).toEqual([
        fresh,
        existing,
      ]);
    });
  });

  describe("remove", () => {
    it("应移除 binding 并递减 total", async () => {
      const bindings = [createTestBinding(), createTestBinding()];
      useOrchestratorStore.setState({ bindings, total: 2 });
      mockTauriInvoke({ delete_task_binding: true });

      await useOrchestratorStore.getState().remove(bindings[0].id);

      const state = useOrchestratorStore.getState();
      expect(state.bindings).toEqual([bindings[1]]);
      expect(state.total).toBe(1);
    });

    it("total 不会低于 0", async () => {
      const binding = createTestBinding();
      useOrchestratorStore.setState({ bindings: [binding], total: 0 });
      mockTauriInvoke({ delete_task_binding: true });

      await useOrchestratorStore.getState().remove(binding.id);

      expect(useOrchestratorStore.getState().total).toBe(0);
    });
  });

  describe("removeCascade", () => {
    it("应级联删除 leader 及其后代", async () => {
      const leader = createTestBinding({ role: "leader" });
      const child = createTestBinding({ role: "worker", parentId: leader.id });
      const grandchild = createTestBinding({ parentId: child.id });
      const other = createTestBinding();
      useOrchestratorStore.setState({
        bindings: [leader, child, grandchild, other],
        total: 4,
      });
      mockTauriInvoke({ delete_task_binding_cascade: true });

      await useOrchestratorStore.getState().removeCascade(leader.id);

      const state = useOrchestratorStore.getState();
      expect(state.bindings).toEqual([other]);
      expect(state.total).toBe(1);
    });
  });

  describe("applyChangedEvent", () => {
    it("delete 事件应移除对应 binding", () => {
      const bindings = [createTestBinding(), createTestBinding()];
      useOrchestratorStore.setState({ bindings, total: 2 });

      useOrchestratorStore.getState().applyChangedEvent({
        op: "delete",
        id: bindings[0].id,
      });

      const state = useOrchestratorStore.getState();
      expect(state.bindings).toEqual([bindings[1]]);
      expect(state.total).toBe(1);
    });

    it("update 事件携带 binding 应 upsert", () => {
      const existing = createTestBinding();
      useOrchestratorStore.setState({ bindings: [existing], total: 1 });
      const updated = { ...existing, title: "改" };

      useOrchestratorStore.getState().applyChangedEvent({
        op: "update",
        id: existing.id,
        binding: updated,
      });

      expect(useOrchestratorStore.getState().bindings).toEqual([updated]);
    });

    it("非 delete 事件缺少 binding 时不改变状态", () => {
      const bindings = [createTestBinding()];
      useOrchestratorStore.setState({ bindings, total: 1 });

      useOrchestratorStore.getState().applyChangedEvent({
        op: "update",
        id: bindings[0].id,
      });

      expect(useOrchestratorStore.getState().bindings).toEqual(bindings);
    });
  });

  describe("过滤器", () => {
    it("setFilterTab 应更新 filterTab 并触发加载", async () => {
      const items = [createTestBinding({ status: "running" })];
      mockTauriInvoke({ query_task_bindings: queryResult(items) });

      useOrchestratorStore.getState().setFilterTab("running");
      expect(useOrchestratorStore.getState().filterTab).toBe("running");

      await flush();
      expect(useOrchestratorStore.getState().bindings).toEqual(items);
    });

    it("setFilterWorkspace 应同时清空 filterProjectPath", async () => {
      useOrchestratorStore.setState({ filterProjectPath: "/old/path" });
      mockTauriInvoke({ query_task_bindings: queryResult([]) });

      useOrchestratorStore.getState().setFilterWorkspace("ws-1");

      const state = useOrchestratorStore.getState();
      expect(state.filterWorkspace).toBe("ws-1");
      expect(state.filterProjectPath).toBeNull();
      await flush();
    });

    it("setFilterProjectPath 应更新 filterProjectPath", async () => {
      mockTauriInvoke({ query_task_bindings: queryResult([]) });
      useOrchestratorStore.getState().setFilterProjectPath("/p");
      expect(useOrchestratorStore.getState().filterProjectPath).toBe("/p");
      await flush();
    });

    it("setFilterRole 应更新 filterRole", async () => {
      mockTauriInvoke({ query_task_bindings: queryResult([]) });
      useOrchestratorStore.getState().setFilterRole("leader");
      expect(useOrchestratorStore.getState().filterRole).toBe("leader");
      await flush();
    });

    it("setSearchKeyword 应更新 searchKeyword", async () => {
      mockTauriInvoke({ query_task_bindings: queryResult([]) });
      useOrchestratorStore.getState().setSearchKeyword("kw");
      expect(useOrchestratorStore.getState().searchKeyword).toBe("kw");
      await flush();
    });
  });

  describe("视图与选择", () => {
    it("setLastTargetProjectPath 应更新目标路径", () => {
      useOrchestratorStore.getState().setLastTargetProjectPath("/target");
      expect(useOrchestratorStore.getState().lastTargetProjectPath).toBe(
        "/target"
      );
    });

    it("setViewType 应切换视图类型", () => {
      useOrchestratorStore.getState().setViewType("tree");
      expect(useOrchestratorStore.getState().viewType).toBe("tree");
    });

    it("setSelectedTaskId 应更新并写入 sessionStorage", () => {
      useOrchestratorStore.getState().setSelectedTaskId("task-x");
      expect(useOrchestratorStore.getState().selectedTaskId).toBe("task-x");
      expect(window.sessionStorage.getItem(SELECTED_TASK_STORAGE_KEY)).toBe(
        "task-x"
      );
    });

    it("setSelectedTaskId(null) 应从 sessionStorage 移除", () => {
      window.sessionStorage.setItem(SELECTED_TASK_STORAGE_KEY, "task-x");
      useOrchestratorStore.getState().setSelectedTaskId(null);
      expect(useOrchestratorStore.getState().selectedTaskId).toBeNull();
      expect(
        window.sessionStorage.getItem(SELECTED_TASK_STORAGE_KEY)
      ).toBeNull();
    });
  });

  describe("getTaskTree", () => {
    it("应构建父子层级树并标注 depth", () => {
      const leader = createTestBinding({ role: "leader" });
      const worker = createTestBinding({ role: "worker", parentId: leader.id });
      useOrchestratorStore.setState({ bindings: [leader, worker] });

      const tree = useOrchestratorStore.getState().getTaskTree();

      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe(leader.id);
      expect(tree[0].depth).toBe(0);
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].id).toBe(worker.id);
      expect(tree[0].children[0].depth).toBe(1);
    });
  });

  describe("getVisibleBindings", () => {
    it("应返回当前 bindings", () => {
      const bindings = [createTestBinding()];
      useOrchestratorStore.setState({ bindings });
      expect(useOrchestratorStore.getState().getVisibleBindings()).toEqual(
        bindings
      );
    });
  });

  describe("getActivityBadge", () => {
    it("应统计失败与活跃任务数", () => {
      useOrchestratorStore.setState({
        bindings: [
          createTestBinding({ status: "running" }),
          createTestBinding({ status: "waiting" }),
          createTestBinding({ status: "failed" }),
          createTestBinding({ status: "completed" }),
        ],
      });

      const badge = useOrchestratorStore.getState().getActivityBadge();
      expect(badge.failed).toBe(true);
      expect(badge.activeCount).toBe(2);
    });

    it("无失败无活跃时应返回 false 与 0", () => {
      useOrchestratorStore.setState({
        bindings: [createTestBinding({ status: "completed" })],
      });

      const badge = useOrchestratorStore.getState().getActivityBadge();
      expect(badge.failed).toBe(false);
      expect(badge.activeCount).toBe(0);
    });
  });

  describe("updateBySessionId", () => {
    it("找到 binding 时应 patch 并 upsert", async () => {
      const binding = createTestBinding({ sessionId: "sess-1" });
      useOrchestratorStore.setState({ bindings: [binding] });
      const patched = { ...binding, status: "completed" as const };
      mockTauriInvoke({
        find_task_binding_by_session: binding,
        update_task_binding_patch: patched,
      });

      await useOrchestratorStore
        .getState()
        .updateBySessionId("sess-1", { status: "completed" });

      expect(useOrchestratorStore.getState().bindings).toEqual([patched]);
    });

    it("未找到 binding 时不改变状态", async () => {
      const binding = createTestBinding();
      useOrchestratorStore.setState({ bindings: [binding] });
      mockTauriInvoke({
        find_task_binding_by_session: null,
      });

      await useOrchestratorStore
        .getState()
        .updateBySessionId("unknown", { status: "completed" });

      expect(useOrchestratorStore.getState().bindings).toEqual([binding]);
    });
  });
});
