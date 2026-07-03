import { describe, it, expect, beforeEach } from "vitest";
import { useSpecStore } from "./useSpecStore";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";
import type { SpecEntry } from "@/types/spec";

let specCounter = 0;

function createTestSpec(overrides?: Partial<SpecEntry>): SpecEntry {
  specCounter += 1;
  const id = `spec-${specCounter}`;
  const now = new Date().toISOString();
  return {
    id,
    projectPath: "/tmp/project",
    title: `spec ${id}`,
    fileName: `${id}.md`,
    status: "draft",
    todoId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides,
  };
}

describe("useSpecStore", () => {
  beforeEach(() => {
    resetTauriInvoke();
    specCounter = 0;
    useSpecStore.setState({
      specs: [],
      loading: false,
      selectedSpec: null,
    });
  });

  describe("初始状态", () => {
    it("应有正确的初始值", () => {
      const state = useSpecStore.getState();
      expect(state.specs).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.selectedSpec).toBeNull();
    });
  });

  describe("loadSpecs", () => {
    it("应加载 spec 列表并清除 loading", async () => {
      const specs = [createTestSpec(), createTestSpec()];
      mockTauriInvoke({ list_specs: specs });

      await useSpecStore.getState().loadSpecs("/tmp/project");

      const state = useSpecStore.getState();
      expect(state.specs).toEqual(specs);
      expect(state.loading).toBe(false);
    });

    it("加载期间应设置 loading 为 true", async () => {
      mockTauriInvoke({
        list_specs: () =>
          new Promise((resolve) => setTimeout(() => resolve([]), 10)),
      });

      const promise = useSpecStore.getState().loadSpecs("/tmp/project");
      expect(useSpecStore.getState().loading).toBe(true);

      await promise;
      expect(useSpecStore.getState().loading).toBe(false);
    });

    it("加载失败时应静默重置 loading 并保持 specs 不变", async () => {
      const existing = [createTestSpec()];
      useSpecStore.setState({ specs: existing });
      mockTauriInvoke({
        list_specs: () => {
          throw new Error("加载失败");
        },
      });

      await useSpecStore.getState().loadSpecs("/tmp/project");

      const state = useSpecStore.getState();
      expect(state.loading).toBe(false);
      expect(state.specs).toEqual(existing);
    });

    it("应支持按 status 过滤参数调用", async () => {
      const specs = [createTestSpec({ status: "active" })];
      mockTauriInvoke({ list_specs: specs });

      await useSpecStore.getState().loadSpecs("/tmp/project", "active");

      expect(useSpecStore.getState().specs).toEqual(specs);
    });
  });

  describe("createSpec", () => {
    it("应创建 spec 并重新加载列表，返回创建的 spec", async () => {
      const created = createTestSpec({ title: "新规范" });
      const listAfter = [created];
      mockTauriInvoke({
        create_spec: created,
        list_specs: listAfter,
      });

      const result = await useSpecStore
        .getState()
        .createSpec("/tmp/project", "新规范", ["任务1"]);

      expect(result).toEqual(created);
      expect(useSpecStore.getState().specs).toEqual(listAfter);
    });
  });

  describe("updateSpec", () => {
    it("应替换列表中对应的 spec", async () => {
      const spec = createTestSpec();
      useSpecStore.setState({ specs: [spec] });
      const updated = { ...spec, title: "更新后" };
      mockTauriInvoke({ update_spec: updated });

      await useSpecStore.getState().updateSpec(spec.id, { title: "更新后" });

      expect(useSpecStore.getState().specs[0]).toEqual(updated);
    });

    it("若更新的是当前选中项应同步更新 selectedSpec", async () => {
      const spec = createTestSpec();
      useSpecStore.setState({ specs: [spec], selectedSpec: spec });
      const updated = { ...spec, status: "archived" as const };
      mockTauriInvoke({ update_spec: updated });

      await useSpecStore.getState().updateSpec(spec.id, { status: "archived" });

      expect(useSpecStore.getState().selectedSpec).toEqual(updated);
    });

    it("列表中不存在该 id 时不改变 specs", async () => {
      const spec = createTestSpec();
      useSpecStore.setState({ specs: [spec] });
      const updated = createTestSpec({ id: "not-in-list" });
      mockTauriInvoke({ update_spec: updated });

      await useSpecStore.getState().updateSpec("not-in-list", { title: "x" });

      expect(useSpecStore.getState().specs).toEqual([spec]);
    });
  });

  describe("deleteSpec", () => {
    it("应从列表中移除对应 spec", async () => {
      const specs = [createTestSpec(), createTestSpec()];
      useSpecStore.setState({ specs });
      mockTauriInvoke({ delete_spec: undefined });

      await useSpecStore.getState().deleteSpec("/tmp/project", specs[0].id);

      expect(useSpecStore.getState().specs).toEqual([specs[1]]);
    });

    it("删除当前选中项时应清空 selectedSpec", async () => {
      const spec = createTestSpec();
      useSpecStore.setState({ specs: [spec], selectedSpec: spec });
      mockTauriInvoke({ delete_spec: undefined });

      await useSpecStore.getState().deleteSpec("/tmp/project", spec.id);

      const state = useSpecStore.getState();
      expect(state.specs).toEqual([]);
      expect(state.selectedSpec).toBeNull();
    });
  });

  describe("syncTasks", () => {
    it("应调用 service 且不改变本地状态", async () => {
      const specs = [createTestSpec()];
      useSpecStore.setState({ specs });
      mockTauriInvoke({ sync_spec_tasks: undefined });

      await useSpecStore.getState().syncTasks("/tmp/project", specs[0].id);

      expect(useSpecStore.getState().specs).toEqual(specs);
    });
  });

  describe("select", () => {
    it("应设置 selectedSpec", () => {
      const spec = createTestSpec();
      useSpecStore.getState().select(spec);
      expect(useSpecStore.getState().selectedSpec).toEqual(spec);
    });

    it("传入 null 应清空 selectedSpec", () => {
      const spec = createTestSpec();
      useSpecStore.setState({ selectedSpec: spec });
      useSpecStore.getState().select(null);
      expect(useSpecStore.getState().selectedSpec).toBeNull();
    });
  });

  describe("reset", () => {
    it("应恢复到初始状态", () => {
      useSpecStore.setState({
        specs: [createTestSpec()],
        loading: true,
        selectedSpec: createTestSpec(),
      });

      useSpecStore.getState().reset();

      const state = useSpecStore.getState();
      expect(state.specs).toEqual([]);
      expect(state.loading).toBe(false);
      expect(state.selectedSpec).toBeNull();
    });
  });
});
