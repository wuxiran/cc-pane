// 两个要列清楚再确认的操作：替换本地改动的更新、清理上游已删除的技能。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { LibrarySkill } from "@/types/skillLibrary";

function useBusy(action: () => Promise<boolean>) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const done = await action();
    if (!done) setBusy(false);
  };
  return { busy, run };
}

/** 「用上游版本替换你对 X 的改动？」[保留我的] [更新]。返回 true 表示完成，可以关掉 */
export function UpdateEditedDialog({
  skill,
  onKeep,
  onUpdate,
}: {
  skill: LibrarySkill;
  onKeep: () => void;
  onUpdate: () => Promise<boolean>;
}) {
  const { t } = useTranslation("settings");
  const { busy, run } = useBusy(onUpdate);
  const unknown = skill.edited === "unknown";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onKeep(); }}>
      <DialogContent className="sm:max-w-md" data-testid="skill-update-edited-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">{t("skillLibrary.confirmUpdate.title", { name: skill.name })}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {unknown ? t("skillLibrary.confirmUpdate.unknownBody", { name: skill.name }) : t("skillLibrary.confirmUpdate.body", { name: skill.name })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onKeep}>{t("skillLibrary.confirmUpdate.keep")}</Button>
          <Button size="sm" disabled={busy} onClick={() => void run()} data-testid="skill-update-edited-confirm">{t("skillLibrary.update")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 清理上游已删除：列出名字，改过的标出来；确认后移到备份 */
export function RemoveGoneDialog({
  skills,
  onCancel,
  onConfirm,
}: {
  skills: readonly LibrarySkill[];
  onCancel: () => void;
  onConfirm: () => Promise<boolean>;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { busy, run } = useBusy(onConfirm);
  const single = skills.length === 1;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md" data-testid="skill-remove-gone-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">
            {single ? t("skillLibrary.confirmGone.titleOne", { name: skills[0].name }) : t("skillLibrary.confirmGone.title", { count: skills.length })}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">{t("skillLibrary.confirmGone.body")}</DialogDescription>
        </DialogHeader>
        <ul className="app-scrollbar max-h-60 space-y-1 overflow-y-auto text-xs" data-testid="skill-remove-gone-list">
          {skills.map((skill) => (
            <li key={skill.id} className="flex items-center gap-2" style={{ color: "var(--app-text-primary)" }}>
              <span className="truncate">{skill.name}</span>
              {skill.edited === "yes" && (
                <span className="shrink-0 rounded-full border px-1.5 text-[length:var(--text-micro)]" style={{ color: "var(--app-status-warning, var(--app-text-secondary))" }}>
                  {t("skillLibrary.tag.edited")}
                </span>
              )}
            </li>
          ))}
        </ul>
        <p className="text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.backupHint")}</p>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onCancel}>{t("common:cancel")}</Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run()} data-testid="skill-remove-gone-confirm">
            {single ? t("skillLibrary.remove") : t("skillLibrary.removeCount", { count: skills.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
