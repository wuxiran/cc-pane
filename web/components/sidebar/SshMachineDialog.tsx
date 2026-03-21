import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, Wifi, WifiOff } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSshMachinesStore } from "@/stores";
import { checkSshConnectivity } from "@/services/sshMachineService";
import { getErrorMessage } from "@/utils";
import type { SshMachine, AuthMethod, SshConnectivityResult } from "@/types";

interface SshMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑模式时传入已有机器 */
  machine?: SshMachine | null;
}

export default function SshMachineDialog({
  open, onOpenChange, machine,
}: SshMachineDialogProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const addMachine = useSshMachinesStore((s) => s.add);
  const updateMachine = useSshMachinesStore((s) => s.update);

  const isEdit = !!machine;

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("key");
  const [identityFile, setIdentityFile] = useState("");
  const [defaultPath, setDefaultPath] = useState("");
  const [tagsStr, setTagsStr] = useState("");
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SshConnectivityResult | null>(null);

  const resetForm = useCallback(() => {
    setName("");
    setHost("");
    setPort("22");
    setUser("");
    setAuthMethod("key");
    setIdentityFile("");
    setDefaultPath("");
    setTagsStr("");
    setTestResult(null);
  }, []);

  // 打开时填充 / 关闭时重置
  useEffect(() => {
    if (open && machine) {
      setName(machine.name);
      setHost(machine.host);
      setPort(String(machine.port));
      setUser(machine.user || "");
      setAuthMethod(machine.authMethod);
      setIdentityFile(machine.identityFile || "");
      setDefaultPath(machine.defaultPath || "");
      setTagsStr(machine.tags.join(", "));
    } else if (!open) {
      resetForm();
    }
  }, [open, machine, resetForm]);

  /** 解析 user@host:port 快速连接格式 */
  const parseQuickConnect = useCallback((input: string) => {
    const trimmed = input.trim();
    // 格式: [user@]host[:port]
    let u = "";
    let h = trimmed;
    let p = "22";

    if (h.includes("@")) {
      const idx = h.indexOf("@");
      u = h.slice(0, idx);
      h = h.slice(idx + 1);
    }
    if (h.includes(":")) {
      const idx = h.lastIndexOf(":");
      const maybePort = h.slice(idx + 1);
      if (/^\d+$/.test(maybePort)) {
        p = maybePort;
        h = h.slice(0, idx);
      }
    }

    if (h) {
      setHost(h);
      if (u) setUser(u);
      if (p !== "22") setPort(p);
      if (!name) setName(h);
    }
  }, [name]);

  /** 表单是否被修改（与已保存值不一致） */
  const isFormDirty = isEdit && machine ? (
    name !== machine.name ||
    host !== machine.host ||
    port !== String(machine.port) ||
    user !== (machine.user || "") ||
    authMethod !== machine.authMethod ||
    identityFile !== (machine.identityFile || "") ||
    defaultPath !== (machine.defaultPath || "") ||
    tagsStr !== machine.tags.join(", ")
  ) : false;

  /** 测试连接 — 仅编辑模式 + 表单未修改（测试已保存配置） */
  const handleTestConnection = useCallback(async () => {
    if (!machine?.id || !open) return;
    setTesting(true);
    setTestResult(null);
    // 捕获当前 generation 防止关闭后 stale 回写
    const currentId = machine.id;
    try {
      const result = await checkSshConnectivity(currentId);
      // 仅当对话框仍打开且仍是同一台机器时才写入状态
      setTestResult((prev) => prev === null || prev === undefined ? result : prev);
      if (result.reachable) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      setTestResult({ reachable: false, message: msg, latencyMs: null });
      toast.error(msg);
    } finally {
      setTesting(false);
    }
  }, [machine, open]);

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) {
      toast.error(t("ssh.nameRequired", { defaultValue: "Name is required" }));
      return;
    }
    if (!host.trim()) {
      toast.error(t("sshHostRequired"));
      return;
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      toast.error(t("sshPortInvalid"));
      return;
    }

    const tags = tagsStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const now = new Date().toISOString();
    const data: SshMachine = {
      id: machine?.id || crypto.randomUUID(),
      name: name.trim(),
      host: host.trim(),
      port: portNum,
      user: user.trim() || undefined,
      authMethod,
      identityFile: authMethod === "key" && identityFile.trim() ? identityFile.trim() : undefined,
      defaultPath: defaultPath.trim() || undefined,
      tags,
      createdAt: machine?.createdAt || now,
      updatedAt: now,
    };

    setLoading(true);
    try {
      if (isEdit) {
        await updateMachine(data);
        toast.success(t("ssh.updated", { defaultValue: "SSH machine updated" }));
      } else {
        await addMachine(data);
        toast.success(t("ssh.added", { defaultValue: "SSH machine added" }));
      }
      resetForm();
      onOpenChange(false);
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [name, host, port, user, authMethod, identityFile, defaultPath, tagsStr, machine, isEdit, addMachine, updateMachine, t, resetForm, onOpenChange]);

  const authOptions: { value: AuthMethod; label: string }[] = [
    { value: "key", label: t("ssh.authKey", { defaultValue: "Key" }) },
    { value: "password", label: t("ssh.authPassword", { defaultValue: "Password" }) },
    { value: "agent", label: t("ssh.authAgent", { defaultValue: "Agent" }) },
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("ssh.editMachine", { defaultValue: "Edit SSH Machine" })
              : t("ssh.addMachine", { defaultValue: "Add SSH Machine" })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          {/* Quick Connect — 新建模式 */}
          {!isEdit && (
            <div>
              <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
                {t("ssh.quickConnect", { defaultValue: "Quick Connect" })}
              </label>
              <Input
                placeholder="user@host:port"
                onBlur={(e) => parseQuickConnect(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") parseQuickConnect(e.currentTarget.value);
                }}
              />
              <p className="text-[10px] text-[var(--app-text-muted)] mt-0.5">
                {t("ssh.quickConnectHint", { defaultValue: "Parse user@host:port to fill fields below" })}
              </p>
            </div>
          )}

          {/* Name */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("ssh.labelName", { defaultValue: "Name" })} *
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("ssh.namePlaceholder", { defaultValue: "My Server" })}
            />
          </div>

          {/* Host */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("sshLabelHost")} *
            </label>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>

          {/* Port + User — 同行 */}
          <div className="flex gap-2">
            <div className="w-24">
              <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
                {t("sshLabelPort")}
              </label>
              <Input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
                {t("sshLabelUser")}
              </label>
              <Input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder={t("sshUserPlaceholder")}
              />
            </div>
          </div>

          {/* Auth Method */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("ssh.labelAuthMethod", { defaultValue: "Auth Method" })}
            </label>
            <div className="flex gap-1">
              {authOptions.map((opt) => (
                <button
                  key={opt.value}
                  className="px-3 py-1 text-xs rounded transition-colors"
                  style={{
                    background: authMethod === opt.value ? "var(--app-accent)" : "var(--app-hover)",
                    color: authMethod === opt.value ? "white" : "var(--app-text-primary)",
                  }}
                  onClick={() => setAuthMethod(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Password 提示 — 仅 password 模式 */}
          {authMethod === "password" && (
            <p className="text-[10px] text-[var(--app-text-muted)] -mt-1">
              {t("ssh.passwordNote", { defaultValue: "Password will be prompted at connection time" })}
            </p>
          )}

          {/* Identity File — 仅 key 模式 */}
          {authMethod === "key" && (
            <div>
              <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
                {t("sshLabelIdentityFile")}
              </label>
              <Input
                value={identityFile}
                onChange={(e) => setIdentityFile(e.target.value)}
                placeholder="~/.ssh/id_rsa"
              />
            </div>
          )}

          {/* Default Path */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("ssh.labelDefaultPath", { defaultValue: "Default Path" })}
            </label>
            <Input
              value={defaultPath}
              onChange={(e) => setDefaultPath(e.target.value)}
              placeholder={t("ssh.defaultPathPlaceholder", { defaultValue: "~/projects (default: ~)" })}
            />
          </div>

          {/* Tags */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("ssh.labelTags", { defaultValue: "Tags" })}
            </label>
            <Input
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              placeholder={t("ssh.tagsPlaceholder", { defaultValue: "production, web (comma separated)" })}
            />
          </div>
        </div>
        <DialogFooter className="flex items-center gap-2 sm:justify-between">
          <div className="flex items-center gap-2">
            {isEdit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleTestConnection}
                      disabled={testing || loading || isFormDirty}
                      className="gap-1.5"
                    >
                      {testing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : testResult?.reachable ? (
                        <Wifi className="w-3.5 h-3.5 text-green-500" />
                      ) : testResult ? (
                        <WifiOff className="w-3.5 h-3.5 text-red-500" />
                      ) : (
                        <Wifi className="w-3.5 h-3.5" />
                      )}
                      {t("ssh.testConnection", { defaultValue: "Test" })}
                    </Button>
                  </span>
                </TooltipTrigger>
                {isFormDirty && (
                  <TooltipContent>
                    <p>{t("ssh.testSavedOnly", { defaultValue: "Save changes first to test" })}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => { resetForm(); onOpenChange(false); }}>
              {t("cancel", { ns: "common" })}
            </Button>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading
                ? (isEdit ? t("ssh.saving", { defaultValue: "Saving..." }) : t("adding"))
                : t("confirm", { ns: "common" })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
