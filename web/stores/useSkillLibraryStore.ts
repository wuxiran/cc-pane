// 资源库 · 技能：资源库里的技能和最近一次检查更新的结果。检查结果后端只放内存，
// 页面切走再回来不该丢，所以放在 store 里而不是组件 state。
import { create } from "zustand";
import { skillLibraryService } from "@/services/skillLibraryService";
import type {
  LibrarySkill,
  SkillCheck,
  SkillImportResult,
  SkillInstallResult,
  SkillRemoveResult,
  SkillUpdateResult,
} from "@/types/skillLibrary";

export const SKILLS_CHECKED_AT_KEY = "cc-panes.resourceCenter.skillsCheckedAt";

export function readSkillsCheckedAt(): number | null {
  try {
    const raw = localStorage.getItem(SKILLS_CHECKED_AT_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function writeSkillsCheckedAt(time: number) {
  try {
    localStorage.setItem(SKILLS_CHECKED_AT_KEY, String(time));
  } catch {
    // 只影响下次是否自动检查
  }
}

interface SkillLibraryState {
  skills: LibrarySkill[];
  loaded: boolean;
  checks: Record<string, SkillCheck>;
  checking: boolean;
  load: () => Promise<void>;
  /** 不传 ids 时检查全部，成功后记下检查时间 */
  check: (ids?: string[]) => Promise<SkillCheck[]>;
  install: (probeId: string, paths: string[]) => Promise<SkillInstallResult>;
  update: (ids: string[], replaceEdited: boolean) => Promise<SkillUpdateResult>;
  remove: (ids: string[]) => Promise<SkillRemoveResult>;
  importFound: (keys: string[]) => Promise<SkillImportResult>;
}

function withoutChecks(checks: Record<string, SkillCheck>, ids: readonly string[]): Record<string, SkillCheck> {
  const next = { ...checks };
  for (const id of ids) delete next[id];
  return next;
}

export const useSkillLibraryStore = create<SkillLibraryState>((set, get) => ({
  skills: [],
  loaded: false,
  checks: {},
  checking: false,

  async load() {
    const skills = await skillLibraryService.list();
    set({ skills, loaded: true });
  },

  async check(ids) {
    set({ checking: true });
    try {
      const results = await skillLibraryService.check(ids);
      const checks = { ...get().checks };
      for (const result of results) checks[result.id] = result;
      set({ checks });
      if (!ids) writeSkillsCheckedAt(Date.now());
      // 检查会持久化 gone 标记，重读一次让列表跟上
      await get().load();
      return results;
    } finally {
      set({ checking: false });
    }
  },

  async install(probeId, paths) {
    const result = await skillLibraryService.install(probeId, paths);
    await get().load();
    return result;
  },

  async update(ids, replaceEdited) {
    const result = await skillLibraryService.update(ids, replaceEdited);
    set({ checks: withoutChecks(get().checks, result.updated) });
    await get().load();
    return result;
  },

  async remove(ids) {
    const result = await skillLibraryService.remove(ids);
    set({ checks: withoutChecks(get().checks, result.removed) });
    await get().load();
    return result;
  },

  async importFound(keys) {
    const result = await skillLibraryService.import(keys);
    await get().load();
    return result;
  },
}));
