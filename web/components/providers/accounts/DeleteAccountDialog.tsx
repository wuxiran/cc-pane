import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface DeleteAccountDialogProps {
  open: boolean;
  name: string;
  /** 登录账号才有「同时删除登录目录」。 */
  isLogin: boolean;
  configDir?: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (deleteDir: boolean) => void;
}

/** 删除账号前写清后果；登录账号可勾选同时删除登录目录（默认不勾）。 */
export default function DeleteAccountDialog({
  open,
  name,
  isLogin,
  configDir,
  busy,
  onCancel,
  onConfirm,
}: DeleteAccountDialogProps) {
  const { t } = useTranslation(["providers", "common"]);
  const [deleteDir, setDeleteDir] = useState(false);

  useEffect(() => {
    if (open) setDeleteDir(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("providers:providerAccounts.remove.title", { name })}</DialogTitle>
          <DialogDescription>{t("providers:providerAccounts.remove.description")}</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-xs" style={{ color: "var(--app-text-secondary)" }}>
          <li>{t("providers:providerAccounts.remove.consequenceProfiles")}</li>
          <li>{t("providers:providerAccounts.remove.consequenceHistory")}</li>
          {isLogin && <li>{t("providers:providerAccounts.remove.consequenceLoginDir")}</li>}
        </ul>
        {isLogin && (
          <div className="flex flex-col gap-1">
            <CheckboxRow
              checked={deleteDir}
              onCheckedChange={(checked) => setDeleteDir(checked === true)}
              label={t("providers:providerAccounts.remove.deleteDir")}
            />
            {configDir && (
              <p className="break-all pl-6 font-mono text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
                {configDir}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("common:cancel")}
          </Button>
          <Button variant="destructive" onClick={() => onConfirm(isLogin && deleteDir)} disabled={busy}>
            {busy ? t("providers:providerAccounts.remove.deleting") : t("providers:providerAccounts.remove.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
