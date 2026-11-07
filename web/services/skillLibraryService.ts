// 资源库 · 技能：桌面走 Tauri 命令，Web 壳走 cc-panes-web 的 REST（docs/109 第 2 批 B 节）。
import type {
  FoundSkill,
  LibrarySkill,
  SkillCheck,
  SkillImportResult,
  SkillInstallResult,
  SkillLibraryContent,
  SkillProbe,
  SkillRemoveResult,
  SkillUpdateResult,
} from "@/types/skillLibrary";
import { apiGet, apiJson, invokeOrApi } from "./apiClient";

const BASE = "/api/skill-library";

export const skillLibraryService = {
  list(): Promise<LibrarySkill[]> {
    return invokeOrApi<LibrarySkill[]>("skill_library_list", undefined, () => apiGet<LibrarySkill[]>(BASE));
  },

  read(id: string): Promise<SkillLibraryContent> {
    return invokeOrApi<SkillLibraryContent>("skill_library_read", { id }, () =>
      apiGet<SkillLibraryContent>(`${BASE}/${encodeURIComponent(id)}`),
    );
  },

  probe(source: string): Promise<SkillProbe> {
    return invokeOrApi<SkillProbe>("skill_library_probe", { source }, () =>
      apiJson<SkillProbe>(`${BASE}/probe`, "POST", { source }),
    );
  },

  install(probeId: string, paths: string[]): Promise<SkillInstallResult> {
    return invokeOrApi<SkillInstallResult>("skill_library_install", { probeId, paths }, () =>
      apiJson<SkillInstallResult>(`${BASE}/install`, "POST", { probeId, paths }),
    );
  },

  /** 不传 ids 时检查全部 */
  check(ids?: string[]): Promise<SkillCheck[]> {
    const body = { ids: ids ?? null };
    return invokeOrApi<SkillCheck[]>("skill_library_check", body, () =>
      apiJson<SkillCheck[]>(`${BASE}/check`, "POST", body),
    );
  },

  update(ids: string[], replaceEdited: boolean): Promise<SkillUpdateResult> {
    return invokeOrApi<SkillUpdateResult>("skill_library_update", { ids, replaceEdited }, () =>
      apiJson<SkillUpdateResult>(`${BASE}/update`, "POST", { ids, replaceEdited }),
    );
  },

  remove(ids: string[]): Promise<SkillRemoveResult> {
    return invokeOrApi<SkillRemoveResult>("skill_library_remove", { ids }, () =>
      apiJson<SkillRemoveResult>(`${BASE}/remove`, "POST", { ids }),
    );
  },

  found(): Promise<FoundSkill[]> {
    return invokeOrApi<FoundSkill[]>("skill_library_found", undefined, () => apiGet<FoundSkill[]>(`${BASE}/found`));
  },

  import(keys: string[]): Promise<SkillImportResult> {
    return invokeOrApi<SkillImportResult>("skill_library_import", { keys }, () =>
      apiJson<SkillImportResult>(`${BASE}/import`, "POST", { keys }),
    );
  },
};
