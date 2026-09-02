// Agent Skills 数据层，按作用域切换后端：项目（仓库多根）或工作空间（单一挂载目录）。
// 列表 / 选中内容 / 保存 / 删除 / 移动（仅项目）/ 导入；写操作成功后重拉列表并修正选中。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { skillService } from "@/services/skillService";
import type {
  ProjectSkill,
  ProjectSkillContent,
  ProjectSkillImportSource,
  ProjectSkillRoot,
  SkillImportTarget,
  SkillScope,
} from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import { FALLBACK_ROOTS, WORKSPACE_VIRTUAL_ROOT } from "./projectSkillModel";

export function useProjectSkills(scopeInput: SkillScope) {
  const { t } = useTranslation("projectSkills");
  // 调用方常内联构造 scope 对象；按内容键固化引用，回调依赖才不会每次渲染都失效
  const scopeKey = scopeInput.kind === "project" ? `p:${scopeInput.projectPath}` : `w:${scopeInput.workspaceName}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey 就是 scopeInput 的内容指纹
  const scope = useMemo(() => scopeInput, [scopeKey]);
  const [projectRoots, setProjectRoots] = useState<ProjectSkillRoot[]>(FALLBACK_ROOTS);
  const [skills, setSkills] = useState<ProjectSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProjectSkillContent | null>(null);
  const [busy, setBusy] = useState(false);

  const roots = useMemo<ProjectSkillRoot[]>(
    () => (scope.kind === "workspace" ? [WORKSPACE_VIRTUAL_ROOT] : projectRoots),
    [scope.kind, projectRoots],
  );

  const listSkills = useCallback(
    () =>
      scope.kind === "project"
        ? skillService.listProjectSkills(scope.projectPath)
        : skillService.listWorkspaceSkills(scope.workspaceName),
    [scope],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listSkills();
      setSkills(list);
      return list;
    } catch (error) {
      toast.error(t("toast.loadFailed", { error: String(error) }));
      return [];
    } finally {
      setLoading(false);
    }
  }, [listSkills, t]);

  useEffect(() => {
    if (scope.kind !== "project") return;
    skillService
      .listProjectSkillRoots()
      .then((list) => {
        if (list.length > 0) setProjectRoots(list);
      })
      .catch((error) => handleErrorSilent(error, "list project skill roots"));
  }, [scope.kind]);

  useEffect(() => {
    setSelectedId(null);
    setSelected(null);
    void reload();
  }, [reload]);

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
    const request =
      scope.kind === "project"
        ? skillService.readProjectSkill(scope.projectPath, target.root, target.relDir)
        : skillService.readWorkspaceSkill(scope.workspaceName, target.relDir);
    request
      .then((content) => {
        if (!cancelled) setSelected(content);
      })
      .catch((error) => handleErrorSilent(error, "read skill"));
    return () => {
      cancelled = true;
    };
  }, [selectedId, skills, scope]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, onOk?: (value: T) => void | Promise<void>): Promise<T | null> => {
      setBusy(true);
      try {
        const value = await action();
        await onOk?.(value);
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
        () =>
          scope.kind === "project"
            ? skillService.saveProjectSkill(scope.projectPath, root, name, content)
            : skillService.saveWorkspaceSkill(scope.workspaceName, name, content),
        async (saved) => {
          toast.success(t("toast.saved", { name: saved.name }));
          await reload();
          setSelectedId(saved.id);
        },
      ),
    [scope, reload, run, t],
  );

  const remove = useCallback(
    (skill: ProjectSkill) =>
      run(
        () =>
          scope.kind === "project"
            ? skillService.deleteProjectSkill(scope.projectPath, skill.root, skill.relDir)
            : skillService.deleteWorkspaceSkill(scope.workspaceName, skill.relDir),
        async () => {
          toast.success(t("toast.deleted", { name: skill.name }));
          if (selectedId === skill.id) setSelectedId(null);
          await reload();
        },
      ),
    [scope, reload, run, selectedId, t],
  );

  const move = useCallback(
    (skill: ProjectSkill, toRoot: string) => {
      if (scope.kind !== "project") return Promise.resolve(null);
      return run(
        () => skillService.moveProjectSkill(scope.projectPath, skill.root, skill.relDir, toRoot),
        async (moved) => {
          toast.success(t("toast.moved", { name: moved.name, root: toRoot }));
          await reload();
          setSelectedId(moved.id);
        },
      );
    },
    [scope, reload, run, t],
  );

  const importSkill = useCallback(
    (root: string, source: ProjectSkillImportSource, options?: { name?: string; overwrite?: boolean }) => {
      const target: SkillImportTarget =
        scope.kind === "project"
          ? { kind: "project", projectPath: scope.projectPath, root }
          : { kind: "workspace", workspaceName: scope.workspaceName };
      return run(
        () => skillService.importSkill(target, source, options),
        async (imported) => {
          toast.success(t("toast.imported", { name: imported.name, root: imported.root }));
          await reload();
          setSelectedId(imported.id);
        },
      );
    },
    [scope, reload, run, t],
  );

  return {
    scope,
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
