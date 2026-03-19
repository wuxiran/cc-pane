import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspacesStore, useSshMachinesStore } from "@/stores";
import { getErrorMessage } from "@/utils";

interface AddSshProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName: string;
}

export default function AddSshProjectDialog({
  open, onOpenChange, workspaceName,
}: AddSshProjectDialogProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const addSshProject = useWorkspacesStore((s) => s.addSshProject);

  const machines = useSshMachinesStore((s) => s.machines);
  const loadMachines = useSshMachinesStore((s) => s.load);
  const addMachine = useSshMachinesStore((s) => s.add);
  const findByConnection = useSshMachinesStore((s) => s.findByConnection);

  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [loading, setLoading] = useState(false);

  const isFromMachine = selectedMachineId !== "";
  const remotePathRef = useRef<HTMLInputElement>(null);

  // 打开时加载机器列表
  useEffect(() => {
    if (open) loadMachines();
  }, [open, loadMachines]);

  // 选择机器后自动聚焦 remotePath 输入框
  useEffect(() => {
    if (isFromMachine && remotePathRef.current) {
      remotePathRef.current.focus();
    }
  }, [isFromMachine]);

  const resetForm = useCallback(() => {
    setSelectedMachineId("");
    setHost("");
    setPort("22");
    setUser("");
    setRemotePath("");
    setIdentityFile("");
  }, []);

  const handleMachineSelect = useCallback((machineId: string) => {
    setSelectedMachineId(machineId);
    if (!machineId) {
      // 切回手动填写，清空连接字段
      setHost("");
      setPort("22");
      setUser("");
      setIdentityFile("");
      return;
    }
    const m = machines.find((item) => String(item.id) === String(machineId));
    if (!m) return;
    setHost(m.host);
    setPort(String(m.port));
    setUser(m.user || "");
    setIdentityFile(m.identityFile || "");
    // remotePath 不填充 — 每个项目独有
  }, [machines]);

  const syncToSshMachines = useCallback(async (sshInfo: {
    host: string; port: number; user?: string; identityFile?: string;
  }) => {
    try {
      const existing = findByConnection(sshInfo.host, sshInfo.port, sshInfo.user);
      if (existing) return;

      const baseName = sshInfo.user ? `${sshInfo.user}@${sshInfo.host}` : sshInfo.host;
      const nameExists = useSshMachinesStore.getState().machines.some(
        (m) => m.name.toLowerCase() === baseName.toLowerCase(),
      );
      const name = nameExists ? `${baseName}:${sshInfo.port}` : baseName;

      await addMachine({
        id: crypto.randomUUID(),
        name,
        host: sshInfo.host,
        port: sshInfo.port,
        user: sshInfo.user,
        authMethod: sshInfo.identityFile ? "key" : "agent",
        identityFile: sshInfo.identityFile,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      console.warn("Failed to sync SSH machine");
    }
  }, [findByConnection, addMachine]);

  const handleSubmit = useCallback(async () => {
    // 前端验证
    if (!host.trim()) {
      toast.error(t("sshHostRequired"));
      return;
    }
    if (!remotePath.trim()) {
      toast.error(t("sshRemotePathRequired"));
      return;
    }
    if (!remotePath.startsWith("/") && !remotePath.startsWith("~")) {
      toast.error(t("sshRemotePathAbsolute"));
      return;
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      toast.error(t("sshPortInvalid"));
      return;
    }

    const sshInfo = {
      host: host.trim(),
      port: portNum,
      user: user.trim() || undefined,
      remotePath: remotePath.trim(),
      identityFile: identityFile.trim() || undefined,
    };

    setLoading(true);
    try {
      await addSshProject(workspaceName, sshInfo);
      // 手动填写时，自动同步到 SSH Machines
      if (!isFromMachine) {
        await syncToSshMachines(sshInfo);
      }
      toast.success(t("sshProjectAdded"));
      resetForm();
      onOpenChange(false);
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [host, port, user, remotePath, identityFile, workspaceName, addSshProject, isFromMachine, syncToSshMachines, t, resetForm, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addSshProject")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          {/* Machine Selector */}
          {machines.length > 0 && (
            <div>
              <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
                {t("ssh.selectMachine")}
              </label>
              <select
                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg-secondary)] px-3 py-2 text-sm text-[var(--app-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--app-accent)]"
                value={selectedMachineId}
                onChange={(e) => handleMachineSelect(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.stopPropagation();
                }}
              >
                <option value="">{t("ssh.manualInput")}</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.user ? `${m.user}@` : ""}{m.host}:{m.port})
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* Host */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("sshLabelHost")} *
            </label>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="my-server / 192.168.1.100"
              disabled={isFromMachine}
              className={isFromMachine ? "opacity-60 cursor-not-allowed" : ""}
            />
          </div>
          {/* Port */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("sshLabelPort")}
            </label>
            <Input
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22"
              disabled={isFromMachine}
              className={isFromMachine ? "opacity-60 cursor-not-allowed" : ""}
            />
          </div>
          {/* User */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("sshLabelUser")}
            </label>
            <Input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={t("sshUserPlaceholder")}
              disabled={isFromMachine}
              className={isFromMachine ? "opacity-60 cursor-not-allowed" : ""}
            />
          </div>
          {/* Remote Path */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("sshLabelRemotePath")} *
            </label>
            <Input
              ref={remotePathRef}
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder="/home/user/project"
            />
          </div>
          {/* Identity File */}
          <div>
            <label className="text-xs font-medium text-[var(--app-text-secondary)] mb-1 block">
              {t("sshLabelIdentityFile")}
            </label>
            <Input
              value={identityFile}
              onChange={(e) => setIdentityFile(e.target.value)}
              placeholder="~/.ssh/id_rsa"
              disabled={isFromMachine}
              className={isFromMachine ? "opacity-60 cursor-not-allowed" : ""}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? t("adding") : t("confirm", { ns: "common" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
