import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LoginAccountCliTool } from "@/types/provider";
import AccountColorPicker from "./AccountColorPicker";

export interface NewLoginAccountInput {
  name: string;
  color: string | null;
  cliTool: LoginAccountCliTool;
}

interface NewLoginAccountDialogProps {
  open: boolean;
  /** 供应商类型决定能挂哪些 CLI；多于一个时让用户选。 */
  cliTools: readonly LoginAccountCliTool[];
  defaultColor: string | null;
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: NewLoginAccountInput) => void;
}

/** 新建登录账号：用户只起名字、选颜色；目录由 CC-Panes 自动建，不让填路径。 */
export default function NewLoginAccountDialog({
  open,
  cliTools,
  defaultColor,
  busy,
  onCancel,
  onCreate,
}: NewLoginAccountDialogProps) {
  const { t } = useTranslation(["providers", "common"]);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(defaultColor);
  const [cliTool, setCliTool] = useState<LoginAccountCliTool | undefined>(cliTools[0]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setColor(defaultColor);
    setCliTool(cliTools[0]);
  }, [open, defaultColor, cliTools]);

  const canCreate = !!name.trim() && !!cliTool && !busy;
  const submit = () => {
    if (!canCreate || !cliTool) return;
    onCreate({ name: name.trim(), color, cliTool });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("providers:providerAccounts.newLogin.title")}</DialogTitle>
          <DialogDescription>{t("providers:providerAccounts.newLogin.description")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-login-account-name" className="text-xs font-medium">
              {t("providers:providerAccounts.account.name")}
            </Label>
            <Input
              id="new-login-account-name"
              className="h-9 text-sm"
              maxLength={128}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("providers:providerAccounts.newLogin.namePlaceholder")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">{t("providers:providerAccounts.account.color")}</span>
            <AccountColorPicker value={color} onChange={setColor} />
          </div>
          {cliTools.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">{t("providers:providerAccounts.newLogin.cli")}</span>
              <div className="flex gap-1.5" role="radiogroup" aria-label={t("providers:providerAccounts.newLogin.cli")}>
                {cliTools.map((tool) => (
                  <Button
                    key={tool}
                    type="button"
                    role="radio"
                    aria-checked={cliTool === tool}
                    variant={cliTool === tool ? "default" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setCliTool(tool)}
                  >
                    {t(`providers:providerAccounts.cli.${tool}`)}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {cliTools.length === 1 && cliTool && (
            <p className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("providers:providerAccounts.newLogin.cliFixed", { cli: t(`providers:providerAccounts.cli.${cliTool}`) })}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onCancel}>
              {t("common:cancel")}
            </Button>
            <Button type="submit" disabled={!canCreate}>
              {busy ? t("providers:providerAccounts.newLogin.creating") : t("providers:providerAccounts.newLogin.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
