// 技能页的写操作：检查、更新（改动过的先确认）、删除、清理上游已删除。结果统一在这里提示。
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastInfo, toastOk, toastWarn } from "@/lib/feedback";
import { nativeConfirm } from "@/services/nativeDialog";
import { useSkillLibraryStore } from "@/stores/useSkillLibraryStore";
import type { LibrarySkill, SkillCheck, SkillUpdateResult } from "@/types/skillLibrary";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import { needsReplaceConfirm, planBulkUpdate } from "./skillLibraryModel";

export function useSkillLibraryActions(reloadProfiles: () => Promise<void>) {
  const { t } = useTranslation("settings");
  const check = useSkillLibraryStore((s) => s.check);
  const update = useSkillLibraryStore((s) => s.update);
  const remove = useSkillLibraryStore((s) => s.remove);
  const [editing, setEditing] = useState<LibrarySkill | null>(null);
  const [gone, setGone] = useState<LibrarySkill[] | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());

  const fail = useCallback((error: unknown) => {
    toastErr(t("skillLibrary.actionFailed", { error: translateError(error) }));
  }, [t]);

  const withBusy = async <T,>(ids: readonly string[], action: () => Promise<T>): Promise<T> => {
    setBusyIds((current) => new Set([...current, ...ids]));
    try {
      return await action();
    } finally {
      setBusyIds((current) => new Set([...current].filter((id) => !ids.includes(id))));
    }
  };

  const reportUpdate = (result: SkillUpdateResult) => {
    if (result.updated.length > 0) toastOk(t("skillLibrary.updated", { count: result.updated.length }));
    if (result.keptEdited.length > 0) toastInfo(t("skillLibrary.keptEdited", { names: result.keptEdited.join(", ") }));
    if (result.gone.length > 0) toastWarn(t("skillLibrary.goneFound", { names: result.gone.join(", ") }));
    for (const item of result.failed) toastErr(t("skillLibrary.updateFailed", { name: item.id, error: item.error }));
  };

  /** silent：进页面时的自动检查，失败不打扰 */
  const checkAll = useCallback(async (silent = false): Promise<SkillCheck[] | null> => {
    try {
      const results = await check();
      if (!silent) {
        const updates = results.filter((item) => item.status === "update").length;
        toastInfo(updates > 0 ? t("skillLibrary.checkHasUpdates", { count: updates }) : t("skillLibrary.checkAllCurrent"));
      }
      return results;
    } catch (error) {
      if (silent) handleErrorSilent(error, "check skill updates");
      else fail(error);
      return null;
    }
  }, [check, fail, t]);

  const runUpdate = async (ids: string[], replaceEdited: boolean): Promise<boolean> => {
    try {
      reportUpdate(await withBusy(ids, () => update(ids, replaceEdited)));
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const updateOne = (skill: LibrarySkill) => {
    if (needsReplaceConfirm(skill)) setEditing(skill);
    else void runUpdate([skill.id], false);
  };

  const confirmEdited = async (): Promise<boolean> => {
    if (!editing) return true;
    const done = await runUpdate([editing.id], true);
    if (done) setEditing(null);
    return done;
  };

  /** 「更新 N 个」：改动过的不动，提示用户逐个处理 */
  const updateMany = async (skills: readonly LibrarySkill[], checks: Readonly<Record<string, SkillCheck>>) => {
    const plan = planBulkUpdate(skills, checks);
    if (plan.skippedNames.length > 0) toastInfo(t("skillLibrary.keptEdited", { names: plan.skippedNames.join(", ") }));
    if (plan.ids.length > 0) await runUpdate(plan.ids, false);
  };

  const runRemove = async (ids: string[]): Promise<boolean> => {
    try {
      const result = await withBusy(ids, () => remove(ids));
      toastOk(t("skillLibrary.removed", { count: result.removed.length }));
      // 后端已从所有启动档里去掉 user:<id>
      await reloadProfiles().catch((error) => handleErrorSilent(error, "reload launch profiles"));
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const removeOne = async (skill: LibrarySkill) => {
    const message = skill.provenance.kind === "folder"
      ? t("skillLibrary.removeConfirmFolder", { name: skill.name })
      : t("skillLibrary.removeConfirm", { name: skill.name });
    if (await nativeConfirm(message, { kind: "warning" })) await runRemove([skill.id]);
  };

  const confirmGone = async (): Promise<boolean> => {
    if (!gone) return true;
    const done = await runRemove(gone.map((skill) => skill.id));
    if (done) setGone(null);
    return done;
  };

  return {
    busyIds,
    checkAll,
    updateOne,
    updateMany,
    removeOne,
    editing,
    cancelEdited: () => setEditing(null),
    confirmEdited,
    gone,
    cleanUp: (skills: LibrarySkill[]) => setGone(skills),
    cancelGone: () => setGone(null),
    confirmGone,
  };
}
