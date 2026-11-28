import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { worktreeService } from "@/services";
import { runWorktreeSetup } from "@/lib/worktreeSetup";
import { useWorktreeSetupStore } from "@/stores/useWorktreeSetupStore";
import { handleError } from "@/utils";

/**
 * worktree 建好后、执行 `.ccpanes/worktree.json` 的 setup 前的一次确认。
 * 关掉 = 不执行；「始终允许」按 项目 + 配置 hash 记住，配置改了会再问。
 */
export default function WorktreeSetupDialog() {
  const { t } = useTranslation("dialogs");
  const plan = useWorktreeSetupStore((state) => state.queue[0] ?? null);
  const shift = useWorktreeSetupStore((state) => state.shift);
  const [busy, setBusy] = useState(false);

  if (!plan) return null;

  const run = async (remember: boolean) => {
    setBusy(true);
    try {
      if (remember) await worktreeService.approveSetup(plan.projectPath, plan.configHash);
      shift();
      await runWorktreeSetup(plan);
    } catch (error) {
      handleError(error, "worktree setup");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) shift(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("worktreeSetup.title")}</DialogTitle>
          <DialogDescription>{t("worktreeSetup.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          <div className="truncate text-[var(--app-text-tertiary)]" title={plan.worktreePath}>
            {plan.worktreePath}
          </div>
          <pre className="max-h-48 overflow-auto rounded-md bg-[var(--app-input-bg)] p-2 font-mono text-xs whitespace-pre-wrap break-all">
            {plan.setup.join("\n")}
          </pre>
          {plan.copiedFiles.length > 0 && (
            <div className="text-xs text-[var(--app-text-tertiary)]">
              {t("worktreeSetup.copied", { files: plan.copiedFiles.join(", ") })}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={shift}>
            {t("worktreeSetup.skip")}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void run(false)}>
            {t("worktreeSetup.runOnce")}
          </Button>
          <Button disabled={busy} onClick={() => void run(true)}>
            {t("worktreeSetup.alwaysAllow")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
