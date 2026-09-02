// 项目 Agent Skills 数据层：根目录清单 / 列表 / 选中内容 / 保存 / 删除 / 移动 / 导入。
// 所有写操作成功后重新拉列表；选中项若被删除或移动则同步修正。
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { skillService } from "@/services/skillService";
import type {
  ProjectSkill,
  ProjectSkillContent,
  ProjectSkillImportSource,
  ProjectSkillRoot,
} from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import { FALLBACK_ROOTS } from "./projectSkillModel";

export function useProjectSkills(projectPath: string) {
  const { t } = useTranslation("projectSkills");
  const [roots, setRoots] = useState<ProjectSkillRoot[]>(FALLBACK_ROOTS);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProjectSkillContent | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await skillService.listProjectSkills(projectPath);
      setSkills(list);
      return list;
    } catch (error) {
      toast.error(t("toast.loadFailed", { error: String(error) }));
      return [];
    } finally {
      setLoading(false);
    }
  }, [projectPath, t]);

  useEffect(() => {
    skillService
      .listProjectSkillRoots()
      .then((list) => {
        if (list.length > 0) setRoots(list);
      })
      .catch((error) => handleErrorSilent(error, "list project skill roots"));
  }, []);

  useEffect(() => {
    setSelectedId(null);
    setSelected(null);
    void reload();
  }, [reload]);

  // 选中项变化时读取 SKILL.md 与文件清单
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const target = skills.find((skill) => skill.id === selectedId);
    if (!target) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    skillService
      .readProjectSkill(projectPath, target.root, target.relDir)
      .then((content) => {
        if (!cancelled) setSelected(content);
      })
      .catch((error) => handleErrorSilent(error, "read project skill"));
    return () => {
      cancelled = true;
    };
  }, [selectedId, skills, projectPath]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, onOk?: (value: T) => void): Promise<T | null> => {
      setBusy(true);
      try {
        const value = await action();
        onOk?.(value);
        return value;
      } catch (error) {
        toast.error(t("toast.failed", { error: String(error) }));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const save = useCallback(
    (root: string, name: string, content: string) =>
      run(
        () => skillService.saveProjectSkill(projectPath, root, name, content),
        async (saved) => {
          toast.success(t("toast.saved", { name: saved.name }));
          await reload();
          setSelectedId(saved.id);
        },
      ),
    [projectPath, reload, run, t],
  );

  const remove = useCallback(
    (skill: ProjectSkill) =>
      run(
        () => skillService.deleteProjectSkill(projectPath, skill.root, skill.relDir),
        async () => {
          toast.success(t("toast.deleted", { name: skill.name }));
          if (selectedId === skill.id) setSelectedId(null);
          await reload();
        },
      ),
    [projectPath, reload, run, selectedId, t],
  );

  const move = useCallback(
    (skill: ProjectSkill, toRoot: string) =>
      run(
        () => skillService.moveProjectSkill(projectPath, skill.root, skill.relDir, toRoot),
        async (moved) => {
          toast.success(t("toast.moved", { name: moved.name, root: toRoot }));
          await reload();
          setSelectedId(moved.id);
        },
      ),
    [projectPath, reload, run, t],
  );

  const importSkill = useCallback(
    (root: string, source: ProjectSkillImportSource, options?: { name?: string; overwrite?: boolean }) =>
      run(
        () => skillService.importProjectSkill(projectPath, root, source, options),
        async (imported) => {
          toast.success(t("toast.imported", { name: imported.name, root }));
          await reload();
          setSelectedId(imported.id);
        },
      ),
    [projectPath, reload, run, t],
  );

  return {
    roots,
    skills,
    loading,
    busy,
    selectedId,
    selected,
    select: setSelectedId,
    reload,
    save,
    remove,
    move,
    importSkill,
  };
}
