// 连接另一台 Windows 上的微信组件：本机用 ssh -L 把它的端口转发过来。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { sshMachineService, WECHAT_DEFAULT_PORT, type WechatRemote } from "@/services";
import type { SshMachine } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";

interface FormState {
  target: string;
  sshPort: string;
  identityFile: string;
  remotePort: string;
}

function formFor(remote: WechatRemote | null): FormState {
  return {
    target: remote?.target ?? "",
    sshPort: remote?.sshPort ? String(remote.sshPort) : "",
    identityFile: remote?.identityFile ?? "",
    remotePort: String(remote?.remotePort ?? WECHAT_DEFAULT_PORT),
  };
}

/** 空串表示「不填」，其余必须是 1–65535 的整数 */
function parsePort(text: string, optional: boolean): number | undefined | null {
  const trimmed = text.trim();
  if (!trimmed) return optional ? undefined : null;
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

/** 表单 → 请求；不合法时返回错误的 i18n key */
type FormError = "wechatComponent.targetInvalid" | "wechatComponent.portInvalid";

export function remoteFromForm(form: FormState): WechatRemote | { error: FormError } {
  const target = form.target.trim();
  if (!target || /\s/.test(target) || target.startsWith("-")) return { error: "wechatComponent.targetInvalid" };
  const sshPort = parsePort(form.sshPort, true);
  const remotePort = parsePort(form.remotePort, false);
  if (sshPort === null || remotePort === null || remotePort === undefined) return { error: "wechatComponent.portInvalid" };
  const identityFile = form.identityFile.trim();
  return { target, remotePort, ...(sshPort ? { sshPort } : {}), ...(identityFile ? { identityFile } : {}) };
}

function machineTarget(machine: SshMachine): string {
  return machine.user ? `${machine.user}@${machine.host}` : machine.host;
}

export default function WechatRemoteDialog({
  open,
  remote,
  onOpenChange,
  onConnect,
}: {
  open: boolean;
  remote: WechatRemote | null;
  onOpenChange: (open: boolean) => void;
  onConnect: (remote: WechatRemote) => Promise<void>;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [form, setForm] = useState<FormState>(() => formFor(remote));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [machines, setMachines] = useState<SshMachine[]>([]);

  useEffect(() => {
    if (!open) return;
    setForm(formFor(remote));
    setError(null);
    // 隧道在后台跑、没法输密码，只列用密钥登录的机器
    sshMachineService.listSshMachines()
      .then((all) => setMachines(all.filter((machine) => machine.authMethod !== "password")))
      .catch((cause) => {
        setMachines([]);
        handleErrorSilent(cause, "list ssh machines");
      });
  }, [open, remote]);

  const fillFrom = (machine: SshMachine) => {
    setForm((current) => ({
      ...current,
      target: machineTarget(machine),
      sshPort: machine.port && machine.port !== 22 ? String(machine.port) : "",
      identityFile: machine.identityFile ?? "",
    }));
  };

  const handleConnect = async () => {
    const parsed = remoteFromForm(form);
    if ("error" in parsed) {
      setError(t(parsed.error));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onConnect(parsed);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const field = "space-y-1";
  const label = "text-xs";
  const hint = "text-[length:var(--text-micro)] text-[color:var(--app-text-tertiary)]";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="wechat-remote-dialog">
        <DialogHeader>
          <DialogTitle className="text-base">{t("wechatComponent.remoteTitle")}</DialogTitle>
          <DialogDescription>{t("wechatComponent.remoteHint")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_7rem]">
          <FormField label={t("wechatComponent.fieldTarget")} className={field} labelClassName={label}>
            {({ id }) => (
              <div className="flex gap-1">
                <Input
                  id={id}
                  value={form.target}
                  placeholder={t("wechatComponent.targetPlaceholder")}
                  className="h-8 font-mono text-sm"
                  onChange={(event) => setForm({ ...form, target: event.target.value })}
                />
                {machines.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" className="h-8 w-8 shrink-0 p-0" aria-label={t("wechatComponent.fillFromMachine")} title={t("wechatComponent.fillFromMachine")}>
                        <Server size={13} aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {machines.map((machine) => (
                        <DropdownMenuItem key={machine.id} onSelect={() => fillFrom(machine)}>
                          <span className="truncate">{machine.name}</span>
                          <span className="ms-2 font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{machineTarget(machine)}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            )}
          </FormField>
          <FormField label={t("wechatComponent.fieldSshPort")} className={field} labelClassName={label}>
            {({ id }) => (
              <Input id={id} value={form.sshPort} placeholder="22" inputMode="numeric" className="h-8 font-mono text-sm" onChange={(event) => setForm({ ...form, sshPort: event.target.value })} />
            )}
          </FormField>
          <FormField label={t("wechatComponent.fieldIdentity")} hint={t("wechatComponent.optional")} className={field} labelClassName={label} hintClassName={hint}>
            {({ id, hintId }) => (
              <Input id={id} aria-describedby={hintId} value={form.identityFile} placeholder="~/.ssh/id_ed25519" className="h-8 font-mono text-sm" onChange={(event) => setForm({ ...form, identityFile: event.target.value })} />
            )}
          </FormField>
          <FormField label={t("wechatComponent.fieldRemotePort")} className={field} labelClassName={label}>
            {({ id }) => (
              <Input id={id} value={form.remotePort} inputMode="numeric" className="h-8 font-mono text-sm" onChange={(event) => setForm({ ...form, remotePort: event.target.value })} />
            )}
          </FormField>
        </div>
        <p className="m-0 text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>
          {t("wechatComponent.remotePortHint", { port: WECHAT_DEFAULT_PORT })}
        </p>
        {error && (
          <p role="alert" className="m-0 break-words text-xs" style={{ color: "var(--app-status-danger)" }}>{error}</p>
        )}

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>{t("common:cancel")}</Button>
          <Button size="sm" disabled={saving} onClick={() => void handleConnect()}>{t("wechatComponent.connect")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
