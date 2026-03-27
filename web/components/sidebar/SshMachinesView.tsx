import { useEffect, useState, useCallback, useRef, memo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Server, MoreHorizontal, Pencil, Trash2, Copy, Terminal, RefreshCw, MonitorSmartphone } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { useSshMachinesStore } from "@/stores";
import { waitForTauri, getErrorMessage } from "@/utils";
import { checkSshConnectivity } from "@/services/sshMachineService";
import SshMachineDialog from "./SshMachineDialog";
import WslDiscoverDialog from "./WslDiscoverDialog";
import type { SshMachine, OpenTerminalOptions, SshConnectivityResult } from "@/types";
import type { SshConnectionInfo } from "@/types/workspace";

/** 检测当前是否为 Windows 平台 */
const isWindows = navigator.platform?.startsWith("Win") ?? false;

/** 格式化连接信息字符串 */
function formatConnection(m: SshMachine): string {
  const userPart = m.user ? `${m.user}@` : "";
  return m.port === 22 ? `${userPart}${m.host}` : `${userPart}${m.host}:${m.port}`;
}

/** 从 SshMachine 构造 OpenTerminalOptions */
function buildTerminalOpts(m: SshMachine): OpenTerminalOptions {
  const remotePath = m.defaultPath || "~";
  const ssh: SshConnectionInfo = {
    host: m.host,
    port: m.port,
    user: m.user,
    remotePath,
    identityFile: m.identityFile,
  };
  const userPart = m.user ? `${m.user}@` : "";
  const portPart = m.port !== 22 ? `:${m.port}` : "";
  const path = `ssh://${userPart}${m.host}${portPart}/${remotePath}`;
  return { path, ssh, machineName: m.name };
}

interface SshMachinesViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

/** 连通性状态: null=未检测, "checking"=检测中, result=已完成 */
type ConnectivityState = null | "checking" | SshConnectivityResult;

export default function SshMachinesView({ onOpenTerminal }: SshMachinesViewProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const machines = useSshMachinesStore((s) => s.machines);
  const load = useSshMachinesStore((s) => s.load);
  const removeMachine = useSshMachinesStore((s) => s.remove);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editMachine, setEditMachine] = useState<SshMachine | null>(null);
  const [wslDialogOpen, setWslDialogOpen] = useState(false);
  const [connectivity, setConnectivity] = useState<Record<string, ConnectivityState>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const abortRef = useRef(false);
  // generation 计数：组件卸载时递增，防止 stale 请求回写 state
  const generationRef = useRef(0);
  const autoCheckedRef = useRef(false);

  useEffect(() => {
    waitForTauri().then((ready) => {
      if (ready) load();
    });
  }, [load]);

  /** 检测单台机器连通性 */
  const checkOne = useCallback(async (machineId: string) => {
    const gen = generationRef.current;
    setConnectivity((prev) => ({ ...prev, [machineId]: "checking" }));
    try {
      const result = await checkSshConnectivity(machineId);
      if (generationRef.current !== gen) return; // stale
      setConnectivity((prev) => ({ ...prev, [machineId]: result }));
    } catch (e) {
      if (generationRef.current !== gen) return; // stale
      setConnectivity((prev) => ({
        ...prev,
        [machineId]: { reachable: false, message: getErrorMessage(e), latencyMs: null },
      }));
    }
  }, []);

  /** 检测所有机器连通性（串行，避免并发 SSH 爆发） */
  const checkAll = useCallback(async () => {
    if (checkingAll || machines.length === 0) return;
    setCheckingAll(true);
    abortRef.current = false;
    for (const m of machines) {
      if (abortRef.current) break;
      await checkOne(m.id);
    }
    if (!abortRef.current) setCheckingAll(false);
  }, [checkingAll, machines, checkOne]);

  // 机器列表加载后自动检测一次在线状态
  useEffect(() => {
    if (machines.length > 0 && !autoCheckedRef.current && !checkingAll) {
      autoCheckedRef.current = true;
      const timer = setTimeout(() => checkAll(), 500);
      return () => clearTimeout(timer);
    }
  }, [machines.length, checkingAll, checkAll]);

  // 组件卸载时中止 + 递增 generation
  useEffect(() => () => {
    abortRef.current = true;
    generationRef.current += 1;
  }, []);

  const handleAdd = useCallback(() => {
    setEditMachine(null);
    setDialogOpen(true);
  }, []);

  const handleEdit = useCallback((machine: SshMachine) => {
    setEditMachine(machine);
    setDialogOpen(true);
  }, []);

  const handleDelete = useCallback(async (machine: SshMachine) => {
    const confirmed = window.confirm(
      t("ssh.confirmDelete", {
        defaultValue: "Are you sure you want to delete \"{{name}}\"?",
        name: machine.name,
      })
    );
    if (!confirmed) return;

    try {
      await removeMachine(machine.id);
      toast.success(t("ssh.deleted", { defaultValue: "SSH machine deleted" }));
    } catch (e) {
      toast.error(getErrorMessage(e));
    }
  }, [removeMachine, t]);

  const handleCopyConnectionInfo = useCallback(async (machine: SshMachine) => {
    const info = machine.user
      ? `${machine.user}@${machine.host}:${machine.port}`
      : `${machine.host}:${machine.port}`;
    try {
      await navigator.clipboard.writeText(info);
      toast.success(t("copiedToClipboard"));
    } catch {
      toast.error(t("copyFailed", { error: "Clipboard API not available" }));
    }
  }, [t]);

  const handleConnect = useCallback((machine: SshMachine) => {
    onOpenTerminal(buildTerminalOpts(machine));
  }, [onOpenTerminal]);

  return (
    <div className="flex flex-col h-full">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0">
        <span
          className="text-[11px] font-bold tracking-wider"
          style={{ color: "var(--app-text-secondary)" }}
        >
          {t("sshMachines", { defaultValue: "SSH MACHINES" })}
        </span>
        <div className="flex items-center gap-0.5">
          {machines.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="h-5 w-5 flex items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)] disabled:opacity-40"
                  onClick={checkAll}
                  disabled={checkingAll}
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${checkingAll ? "animate-spin" : ""}`}
                    style={{ color: "var(--app-text-secondary)" }}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{t("ssh.checkAll", { defaultValue: "Check All Connectivity" })}</p>
              </TooltipContent>
            </Tooltip>
          )}
          {isWindows && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="h-5 w-5 flex items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)]"
                  onClick={() => setWslDialogOpen(true)}
                >
                  <MonitorSmartphone className="w-3.5 h-3.5" style={{ color: "var(--app-text-secondary)" }} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{t("ssh.wsl.discover", { defaultValue: "Discover WSL" })}</p>
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="h-5 w-5 flex items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)]"
                onClick={handleAdd}
              >
                <Plus className="w-3.5 h-3.5" style={{ color: "var(--app-text-secondary)" }} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{t("ssh.addMachine", { defaultValue: "Add SSH Machine" })}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {machines.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Server className="w-8 h-8" style={{ color: "var(--app-text-muted)" }} />
            <p className="text-xs" style={{ color: "var(--app-text-muted)" }}>
              {t("ssh.empty", { defaultValue: "No SSH machines" })}
            </p>
            <button
              className="text-xs px-3 py-1 rounded transition-colors"
              style={{ color: "var(--app-accent)" }}
              onClick={handleAdd}
            >
              {t("ssh.addFirst", { defaultValue: "Add your first machine" })}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {machines.map((machine) => (
              <MachineItem
                key={machine.id}
                machine={machine}
                connectivity={connectivity[machine.id] ?? null}
                onConnect={handleConnect}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onCopy={handleCopyConnectionInfo}
                onCheckConnectivity={checkOne}
              />
            ))}
          </div>
        )}
      </div>

      {/* 对话框 */}
      <SshMachineDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        machine={editMachine}
      />
      {isWindows && (
        <WslDiscoverDialog
          open={wslDialogOpen}
          onOpenChange={setWslDialogOpen}
        />
      )}
    </div>
  );
}

// ---- 机器列表项 ----

interface MachineItemProps {
  machine: SshMachine;
  connectivity: ConnectivityState;
  onConnect: (m: SshMachine) => void;
  onEdit: (m: SshMachine) => void;
  onDelete: (m: SshMachine) => void;
  onCopy: (m: SshMachine) => void;
  onCheckConnectivity: (id: string) => void;
}

/** 连通性状态指示点 */
function StatusDot({ state }: { state: ConnectivityState }) {
  if (state === "checking") {
    return (
      <span className="relative flex h-2 w-2 shrink-0" title="Checking...">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500" />
      </span>
    );
  }
  if (state && state.reachable) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex rounded-full h-2 w-2 shrink-0 bg-green-500" />
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{state.message}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  if (state && !state.reachable) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex rounded-full h-2 w-2 shrink-0 bg-red-500" />
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{state.message}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  // 未检测
  return <span className="inline-flex rounded-full h-2 w-2 shrink-0 bg-gray-400/40" />;
}

const MachineItem = memo(function MachineItem({
  machine, connectivity, onConnect, onEdit, onDelete, onCopy, onCheckConnectivity,
}: MachineItemProps) {
  const { t } = useTranslation(["sidebar", "common"]);

  const menuItems = (
    <>
      <ContextMenuItem onClick={() => onConnect(machine)}>
        <Terminal className="w-3.5 h-3.5 mr-2" />
        {t("ssh.connect", { defaultValue: "Connect" })}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCheckConnectivity(machine.id)}>
        <RefreshCw className="w-3.5 h-3.5 mr-2" />
        {t("ssh.checkConnectivity", { defaultValue: "Check Connectivity" })}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onEdit(machine)}>
        <Pencil className="w-3.5 h-3.5 mr-2" />
        {t("ssh.edit", { defaultValue: "Edit" })}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopy(machine)}>
        <Copy className="w-3.5 h-3.5 mr-2" />
        {t("ssh.copyConnection", { defaultValue: "Copy Connection" })}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => onDelete(machine)}
        className="text-red-500 focus:text-red-500"
      >
        <Trash2 className="w-3.5 h-3.5 mr-2" />
        {t("ssh.delete", { defaultValue: "Delete" })}
      </ContextMenuItem>
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className="group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors hover:bg-[var(--app-hover)]"
          onDoubleClick={() => onConnect(machine)}
        >
          <div className="relative shrink-0">
            <Server
              className="w-4 h-4"
              style={{ color: "var(--app-text-muted)" }}
            />
            <div className="absolute -bottom-0.5 -right-0.5">
              <StatusDot state={connectivity} />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium truncate" style={{ color: "var(--app-text-primary)" }}>
                {machine.name}
              </span>
              {machine.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="text-[9px] px-1 py-0 h-3.5 leading-none"
                >
                  {tag}
                </Badge>
              ))}
            </div>
            <span className="text-[10px] truncate block" style={{ color: "var(--app-text-muted)" }}>
              {formatConnection(machine)}
            </span>
          </div>

          {/* 更多按钮 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="h-5 w-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--app-hover)]"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="w-3.5 h-3.5" style={{ color: "var(--app-text-secondary)" }} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              <DropdownMenuItem onClick={() => onConnect(machine)}>
                <Terminal className="w-3.5 h-3.5 mr-2" />
                {t("ssh.connect", { defaultValue: "Connect" })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCheckConnectivity(machine.id)}>
                <RefreshCw className="w-3.5 h-3.5 mr-2" />
                {t("ssh.checkConnectivity", { defaultValue: "Check Connectivity" })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit(machine)}>
                <Pencil className="w-3.5 h-3.5 mr-2" />
                {t("ssh.edit", { defaultValue: "Edit" })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCopy(machine)}>
                <Copy className="w-3.5 h-3.5 mr-2" />
                {t("ssh.copyConnection", { defaultValue: "Copy Connection" })}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(machine)}
                className="text-red-500 focus:text-red-500"
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                {t("ssh.delete", { defaultValue: "Delete" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[140px]">
        {menuItems}
      </ContextMenuContent>
    </ContextMenu>
  );
});
