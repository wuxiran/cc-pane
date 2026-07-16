import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, Wifi, WifiOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSshMachinesStore } from "@/stores";
import { checkSshConnectivity } from "@/services/sshMachineService";
import { getErrorMessage } from "@/utils";
import type { SshMachine, AuthMethod, SshConnectivityResult } from "@/types";

interface SshMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machine?: SshMachine | null;
}

export default function SshMachineDialog({
  open,
  onOpenChange,
  machine,
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
  const [description, setDescription] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [rememberPassword, setRememberPassword] = useState(false);
  const [clearStoredPassword, setClearStoredPassword] = useState(false);
  const [defaultPath, setDefaultPath] = useState("");
  const [tagsStr, setTagsStr] = useState("");
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SshConnectivityResult | null>(
    null,
  );

  const resetForm = useCallback(() => {
    setName("");
    setHost("");
    setPort("22");
    setUser("");
    setAuthMethod("key");
    setIdentityFile("");
    setDescription("");
    setPasswordInput("");
    setRememberPassword(false);
    setClearStoredPassword(false);
    setDefaultPath("");
    setTagsStr("");
    setTestResult(null);
  }, []);

  useEffect(() => {
    if (open && machine) {
      setName(machine.name);
      setHost(machine.host);
      setPort(String(machine.port));
      setUser(machine.user || "");
      setAuthMethod(machine.authMethod);
      setIdentityFile(machine.identityFile || "");
      setDescription(machine.description || "");
      setPasswordInput("");
      setRememberPassword(!!machine.hasStoredPassword);
      setClearStoredPassword(false);
      setDefaultPath(machine.defaultPath || "");
      setTagsStr(machine.tags.join(", "));
    } else if (!open) {
      resetForm();
    }
  }, [open, machine, resetForm]);

  const parseQuickConnect = useCallback(
    (input: string) => {
      const trimmed = input.trim();
      let parsedUser = "";
      let parsedHost = trimmed;
      let parsedPort = "22";

      if (parsedHost.includes("@")) {
        const idx = parsedHost.indexOf("@");
        parsedUser = parsedHost.slice(0, idx);
        parsedHost = parsedHost.slice(idx + 1);
      }
      if (parsedHost.includes(":")) {
        const idx = parsedHost.lastIndexOf(":");
        const maybePort = parsedHost.slice(idx + 1);
        if (/^\d+$/.test(maybePort)) {
          parsedPort = maybePort;
          parsedHost = parsedHost.slice(0, idx);
        }
      }

      if (parsedHost) {
        setHost(parsedHost);
        if (parsedUser) setUser(parsedUser);
        if (parsedPort !== "22") setPort(parsedPort);
        if (!name) setName(parsedHost);
      }
    },
    [name],
  );

  const hasStoredPassword =
    !!machine?.hasStoredPassword && !clearStoredPassword;
  const passwordSectionVisible = authMethod === "password";

  const isFormDirty =
    isEdit && machine
      ? name !== machine.name ||
        host !== machine.host ||
        port !== String(machine.port) ||
        user !== (machine.user || "") ||
        authMethod !== machine.authMethod ||
        identityFile !== (machine.identityFile || "") ||
        description !== (machine.description || "") ||
        rememberPassword !== !!machine.hasStoredPassword ||
        clearStoredPassword ||
        passwordInput.trim().length > 0 ||
        defaultPath !== (machine.defaultPath || "") ||
        tagsStr !== machine.tags.join(", ")
      : false;

  const handleTestConnection = useCallback(async () => {
    if (!machine?.id || !open) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await checkSshConnectivity(machine.id);
      setTestResult((prev) =>
        prev === null || prev === undefined ? result : prev,
      );
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

    if (
      authMethod === "password" &&
      rememberPassword &&
      !isEdit &&
      !passwordInput.trim()
    ) {
      toast.error(
        t("ssh.passwordRequiredToRemember", {
          defaultValue: "Enter a password before enabling remember password.",
        }),
      );
      return;
    }

    const tags = tagsStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const now = new Date().toISOString();
    const savedMachine: SshMachine = {
      id: machine?.id || crypto.randomUUID(),
      name: name.trim(),
      host: host.trim(),
      port: portNum,
      user: user.trim() || undefined,
      authMethod,
      identityFile:
        authMethod === "key" && identityFile.trim()
          ? identityFile.trim()
          : undefined,
      description: description.trim() || undefined,
      defaultPath: defaultPath.trim() || undefined,
      tags,
      hasStoredPassword: authMethod === "password" ? rememberPassword : false,
      createdAt: machine?.createdAt || now,
      updatedAt: now,
    };

    setLoading(true);
    try {
      const request = {
        machine: savedMachine,
        rememberPassword: authMethod === "password" && rememberPassword,
        passwordInput:
          authMethod === "password" && passwordInput.trim()
            ? passwordInput
            : undefined,
        clearStoredPassword:
          clearStoredPassword ||
          authMethod !== "password" ||
          (authMethod === "password" &&
            !rememberPassword &&
            !!machine?.hasStoredPassword),
      };

      if (isEdit) {
        await updateMachine(request);
        toast.success(
          t("ssh.updated", { defaultValue: "SSH machine updated" }),
        );
      } else {
        await addMachine(request);
        toast.success(t("ssh.added", { defaultValue: "SSH machine added" }));
      }
      resetForm();
      onOpenChange(false);
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [
    name,
    host,
    port,
    user,
    authMethod,
    identityFile,
    description,
    passwordInput,
    rememberPassword,
    clearStoredPassword,
    defaultPath,
    tagsStr,
    machine,
    isEdit,
    addMachine,
    updateMachine,
    t,
    resetForm,
    onOpenChange,
  ]);

  const authOptions: { value: AuthMethod; label: string }[] = [
    { value: "key", label: t("ssh.authKey", { defaultValue: "Key" }) },
    {
      value: "password",
      label: t("ssh.authPassword", { defaultValue: "Password" }),
    },
    { value: "agent", label: t("ssh.authAgent", { defaultValue: "Agent" }) },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetForm();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("ssh.editMachine", { defaultValue: "Edit SSH Machine" })
              : t("ssh.addMachine", { defaultValue: "Add SSH Machine" })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          {!isEdit && (
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
                {t("ssh.quickConnect", { defaultValue: "Quick Connect" })}
              </label>
              <Input
                placeholder="user@host:port"
                onBlur={(e) => parseQuickConnect(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    parseQuickConnect(e.currentTarget.value);
                }}
              />
              <p className="mt-0.5 text-[10px] text-[var(--app-text-muted)]">
                {t("ssh.quickConnectHint", {
                  defaultValue: "Parse user@host:port to fill fields below",
                })}
              </p>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
              {t("ssh.labelName", { defaultValue: "Name" })} *
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("ssh.namePlaceholder", {
                defaultValue: "My Server",
              })}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
              {t("sshLabelHost")} *
            </label>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.100"
            />
          </div>

          <div className="flex gap-2">
            <div className="w-24">
              <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
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
              <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
                {t("sshLabelUser")}
              </label>
              <Input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder={t("sshUserPlaceholder")}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
              {t("ssh.labelAuthMethod", { defaultValue: "Auth Method" })}
            </label>
            <div className="flex gap-1">
              {authOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="rounded px-3 py-1 text-xs transition-colors"
                  style={{
                    background:
                      authMethod === opt.value
                        ? "var(--app-accent)"
                        : "var(--app-hover)",
                    color:
                      authMethod === opt.value
                        ? "white"
                        : "var(--app-text-primary)",
                  }}
                  onClick={() => setAuthMethod(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {passwordSectionVisible && (
            <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg-secondary)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--app-text-secondary)]">
                  {t("ssh.passwordSection", {
                    defaultValue: "Password Storage",
                  })}
                </span>
                {hasStoredPassword && (
                  <span className="text-[10px] text-[var(--app-text-muted)]">
                    {t("ssh.passwordStored", {
                      defaultValue: "Password stored in system keychain",
                    })}
                  </span>
                )}
              </div>
              <Input
                type="password"
                value={passwordInput}
                onChange={(e) => {
                  setPasswordInput(e.target.value);
                  if (e.target.value.trim()) {
                    setClearStoredPassword(false);
                  }
                }}
                placeholder={
                  hasStoredPassword
                    ? t("ssh.passwordPlaceholderOptional", {
                        defaultValue: "Leave blank to keep existing password",
                      })
                    : t("ssh.passwordPlaceholder", {
                        defaultValue: "Enter password",
                      })
                }
              />
              <label className="mt-2 flex items-center gap-2 text-xs text-[var(--app-text-secondary)]">
                <input
                  type="checkbox"
                  checked={rememberPassword}
                  onChange={(e) => {
                    setRememberPassword(e.target.checked);
                    if (e.target.checked) {
                      setClearStoredPassword(false);
                    }
                  }}
                />
                <span>
                  {t("ssh.rememberPassword", {
                    defaultValue:
                      "Remember password in system credential store",
                  })}
                </span>
              </label>
              {hasStoredPassword && (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setClearStoredPassword(true);
                      setRememberPassword(false);
                    }}
                  >
                    {t("ssh.clearStoredPassword", {
                      defaultValue: "Clear stored password",
                    })}
                  </Button>
                  {clearStoredPassword && (
                    <span className="text-[10px] text-[var(--app-text-muted)]">
                      {t("ssh.passwordClearPending", {
                        defaultValue:
                          "Stored password will be removed when you save.",
                      })}
                    </span>
                  )}
                </div>
              )}
              <p className="mt-2 text-[10px] text-[var(--app-text-muted)]">
                {t("ssh.passwordNote", {
                  defaultValue:
                    "Only the first password factor is auto-filled. MFA verification still continues interactively in the terminal.",
                })}
              </p>
            </div>
          )}

          {authMethod === "key" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
                {t("sshLabelIdentityFile")}
              </label>
              <Input
                value={identityFile}
                onChange={(e) => setIdentityFile(e.target.value)}
                placeholder="~/.ssh/id_rsa"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
              {t("ssh.labelDescription", { defaultValue: "Description" })}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("ssh.descriptionPlaceholder", {
                defaultValue: "Environment, owner, jump host, MFA notes...",
              })}
              rows={3}
              className="flex min-h-[72px] w-full rounded-md border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm text-[var(--app-text-primary)] shadow-sm outline-none placeholder:text-[var(--app-text-muted)] focus-visible:ring-1 focus-visible:ring-[var(--app-accent)]"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
              {t("ssh.labelDefaultPath", { defaultValue: "Default Path" })}
            </label>
            <Input
              value={defaultPath}
              onChange={(e) => setDefaultPath(e.target.value)}
              placeholder={t("ssh.defaultPathPlaceholder", {
                defaultValue: "~/projects (default: ~)",
              })}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--app-text-secondary)]">
              {t("ssh.labelTags", { defaultValue: "Tags" })}
            </label>
            <Input
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              placeholder={t("ssh.tagsPlaceholder", {
                defaultValue: "production, web (comma separated)",
              })}
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
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : testResult?.reachable ? (
                        <Wifi className="h-3.5 w-3.5 text-[var(--app-status-success)]" />
                      ) : testResult ? (
                        <WifiOff className="h-3.5 w-3.5 text-[var(--app-status-danger)]" />
                      ) : (
                        <Wifi className="h-3.5 w-3.5" />
                      )}
                      {t("ssh.testConnection", { defaultValue: "Test" })}
                    </Button>
                  </span>
                </TooltipTrigger>
                {isFormDirty && (
                  <TooltipContent>
                    <p>
                      {t("ssh.testSavedOnly", {
                        defaultValue: "Save changes first to test",
                      })}
                    </p>
                  </TooltipContent>
                )}
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                resetForm();
                onOpenChange(false);
              }}
            >
              {t("cancel", { ns: "common" })}
            </Button>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading
                ? isEdit
                  ? t("ssh.saving", { defaultValue: "Saving..." })
                  : t("adding")
                : t("confirm", { ns: "common" })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
