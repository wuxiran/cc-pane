/**
 * Skills 管理端（链接启停）状态管理
 * 中央仓库 + 多 Agent Junction/Symlink 启停 + 工作空间 + 远程更新
 */
import { create } from "zustand";
import { linkSkillService } from "@/services";
import type {
  DisableCounts,
  EnableCounts,
  LinkSnapshot,
  UpdateOutcome,
} from "@/types";
import { translateError } from "@/utils";

export type LinkTargetAgent = string; // "*" 或 Agent 名称
export type LinkStatusFilter = "all" | "linked" | "copied" | "none";

interface LinkSkillState {
  // ============ 状态 ============
  snapshot: LinkSnapshot | null;
  loading: boolean;
  error: string | null;
  targetAgent: LinkTargetAgent; // "*" = 全部 Agent
  statusFilter: LinkStatusFilter;
  keyword: string;
  selection: Set<string>;
  busy: boolean;

  // ============ 操作 ============
  refresh: () => Promise<void>;
  switchWorkspace: (name: string) => Promise<void>;
  addWorkspace: (path: string) => Promise<string>;
  setTargetAgent: (agent: LinkTargetAgent) => void;
  setStatusFilter: (filter: LinkStatusFilter) => void;
  setKeyword: (keyword: string) => void;
  toggleSelect: (dir: string) => void;
  selectAll: (dirs: string[]) => void;
  invertSelection: (dirs: string[]) => void;
  clearSelection: () => void;
  enableSelected: (overwrite: boolean) => Promise<EnableCounts>;
  disableSelected: () => Promise<DisableCounts>;
  updateSelected: () => Promise<UpdateOutcome[]>;
  clear: () => void;
}

export const useLinkSkillStore = create<LinkSkillState>((set, get) => ({
  snapshot: null,
  loading: false,
  error: null,
  targetAgent: "*",
  statusFilter: "all",
  keyword: "",
  selection: new Set<string>(),
  busy: false,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await linkSkillService.snapshot(null);
      // 清掉已不存在的勾选
      const valid = new Set(snapshot.rows.map((r) => r.dir));
      const selection = new Set([...get().selection].filter((dir) => valid.has(dir)));
      set({ snapshot, selection, loading: false });
    } catch (e) {
      set({ error: translateError(e), loading: false });
    }
  },

  switchWorkspace: async (name) => {
    set({ loading: true, error: null, selection: new Set() });
    try {
      await linkSkillService.setWorkspace(name);
      const snapshot = await linkSkillService.snapshot(null);
      set({ snapshot, loading: false });
    } catch (e) {
      set({ error: translateError(e), loading: false });
    }
  },

  addWorkspace: async (path) => {
    const out = await linkSkillService.addWorkspace(path);
    const snapshot = await linkSkillService.snapshot(null);
    set({ snapshot });
    return out.duplicate ? "该项目已在工作空间列表中" : `已添加项目工作空间【${out.name}】`;
  },

  setTargetAgent: (agent) => set({ targetAgent: agent }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),
  setKeyword: (keyword) => set({ keyword }),
  toggleSelect: (dir) => {
    const selection = new Set(get().selection);
    if (selection.has(dir)) selection.delete(dir);
    else selection.add(dir);
    set({ selection });
  },
  selectAll: (dirs) => set({ selection: new Set([...get().selection, ...dirs]) }),
  invertSelection: (dirs) => {
    const selection = new Set(get().selection);
    for (const dir of dirs) {
      if (selection.has(dir)) selection.delete(dir);
      else selection.add(dir);
    }
    set({ selection });
  },
  clearSelection: () => set({ selection: new Set() }),

  enableSelected: async (overwrite) => {
    const { selection, targetAgent } = get();
    const skills = [...selection];
    if (skills.length === 0) {
      return { ok: 0, skip: 0, conflict: 0, nomaster: 0, fail: 0 };
    }
    set({ busy: true });
    try {
      const counts = await linkSkillService.enable(
        skills,
        targetAgent,
        null,
        overwrite
      );
      const fresh = await linkSkillService.snapshot(null);
      const valid = new Set(fresh.rows.map((r) => r.dir));
      set({ snapshot: fresh, selection: new Set([...selection].filter((d) => valid.has(d))) });
      set({ busy: false });
      return counts;
    } catch (e) {
      set({ busy: false, error: translateError(e) });
      throw e;
    }
  },

  disableSelected: async () => {
    const { selection, targetAgent } = get();
    const skills = [...selection];
    if (skills.length === 0) {
      return { ok: 0, skip: 0, protected: 0, fail: 0 };
    }
    set({ busy: true });
    try {
      const counts = await linkSkillService.disable(skills, targetAgent, null);
      const fresh = await linkSkillService.snapshot(null);
      set({ snapshot: fresh, selection: new Set([...selection]) });
      set({ busy: false });
      return counts;
    } catch (e) {
      set({ busy: false, error: translateError(e) });
      throw e;
    }
  },

  updateSelected: async () => {
    const { selection } = get();
    const skills = [...selection];
    if (skills.length === 0) return [];
    set({ busy: true });
    try {
      const outcomes = await linkSkillService.update(skills, null);
      const fresh = await linkSkillService.snapshot(null);
      set({ snapshot: fresh, selection: new Set([...selection]) });
      set({ busy: false });
      return outcomes;
    } catch (e) {
      set({ busy: false, error: translateError(e) });
      throw e;
    }
  },

  clear: () =>
    set({
      snapshot: null,
      loading: false,
      error: null,
      selection: new Set(),
      keyword: "",
      statusFilter: "all",
      targetAgent: "*",
    }),
}));
