import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Server,
  Star,
  Radio,
  Wifi,
} from "lucide-react";
import {
  useRightDockStore,
  useSshMachinePreferencesStore,
  useSshMachinesStore,
  useSshMachineDialogStore,
  useSshRemoteFilesStore,
} from "@/stores";
import { waitForTauri, getErrorMessage } from "@/utils";
import { checkSshConnectivity } from "@/services/sshMachineService";
import SshPasswordDialog from "@/components/ssh/SshPasswordDialog";
import SshMachineDialog from "./SshMachineDialog";
import MachineItem, {
  FilterButton,
  SummaryMetric,
  type ConnectivityState,
} from "./SshMachineItem";
import SshMachinesHeader from "./SshMachinesHeader";
import WslDiscoverDialog from "./WslDiscoverDialog";
import type {
  SshMachine,
  OpenTerminalOptions,
} from "@/types";
import type { SshConnectionInfo } from "@/types/workspace";

/** 检测当前是否为 Windows 平台 */
const isWindows = navigator.platform?.startsWith("Win") ?? false;

/** 从 SshMachine 构造 OpenTerminalOptions */
function buildTerminalOpts(m: SshMachine): OpenTerminalOptions {
  const remotePath = m.defaultPath || "~";
  const ssh: SshConnectionInfo = {
    host: m.host,
    port: m.port,
    user: m.user,
    remotePath,
    identityFile: m.identityFile,
    machineId: m.id,
    authMethod: m.authMethod,
  };
  const userPart = m.user ? `${m.user}@` : "";
  const portPart = m.port !== 22 ? `:${m.port}` : "";
  const path = `ssh://${userPart}${m.host}${portPart}/${remotePath}`;
  return { path, ssh, machineName: m.name };
}

interface SshMachinesViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function SshMachinesView({
  onOpenTerminal,
}: SshMachinesViewProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const machines = useSshMachinesStore((s) => s.machines);
  const load = useSshMachinesStore((s) => s.load);
  const removeMachine = useSshMachinesStore((s) => s.remove);
  const favoriteMachineIds = useSshMachinePreferencesStore(
    (s) => s.favoriteMachineIds,
  );
  const toggleFavorite = useSshMachinePreferencesStore((s) => s.toggleFavorite);
  const openRemoteFiles = useSshRemoteFilesStore((s) => s.openMachine);
  const markSessionPassword = useSshRemoteFilesStore((s) => s.markSessionPassword);
  const hasSessionPassword = useSshRemoteFilesStore((s) => s.hasSessionPassword);
  const addDialogOpen = useSshMachineDialogStore((s) => s.addDialogOpen);
  const closeAddDialog = useSshMachineDialogStore((s) => s.closeAddDialog);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editMachine, setEditMachine] = useState<SshMachine | null>(null);
  const [wslDialogOpen, setWslDialogOpen] = useState(false);
  const [connectivity, setConnectivity] = useState<
    Record<string, ConnectivityState>
  >({});
  const [checkingAll, setCheckingAll] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [pendingConnectionMachine, setPendingConnectionMachine] = useState<SshMachine | null>(null);
  const abortRef = useRef(false);
  // generation 计数：组件卸载时递增，防止 stale 请求回写 state
  const generationRef = useRef(0);
  const autoCheckedRef = useRef(false);

  useEffect(() => {
    waitForTauri().then((ready) => {
      if (ready) load();
    });
  }, [load]);

  useEffect(() => {
    if (!addDialogOpen) return;
    setEditMachine(null);
    setDialogOpen(true);
  }, [addDialogOpen]);

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
        [machineId]: {
          reachable: false,
          message: getErrorMessage(e),
          latencyMs: null,
        },
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
  useEffect(
    () => () => {
      abortRef.current = true;
      generationRef.current += 1;
    },
    [],
  );

  const handleAdd = useCallback(() => {
    setEditMachine(null);
    setDialogOpen(true);
  }, []);

  const handleEdit = useCallback((machine: SshMachine) => {
    setEditMachine(machine);
    setDialogOpen(true);
  }, []);

  const handleDialogOpenChange = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (!open) closeAddDialog();
  }, [closeAddDialog]);

  const handleDelete = useCallback(
    async (machine: SshMachine) => {
      const confirmed = window.confirm(
        t("ssh.confirmDelete", {
          defaultValue: 'Are you sure you want to delete "{{name}}"?',
          name: machine.name,
        }),
      );
      if (!confirmed) return;

      try {
        await removeMachine(machine.id);
        toast.success(
          t("ssh.deleted", { defaultValue: "SSH machine deleted" }),
        );
      } catch (e) {
        toast.error(getErrorMessage(e));
      }
    },
    [removeMachine, t],
  );

  const handleCopyConnectionInfo = useCallback(
    async (machine: SshMachine) => {
      const info = machine.user
        ? `${machine.user}@${machine.host}:${machine.port}`
        : `${machine.host}:${machine.port}`;
      try {
        await navigator.clipboard.writeText(info);
        toast.success(t("copiedToClipboard"));
      } catch {
        toast.error(t("copyFailed", { error: t("ssh.clipboardUnavailable") }));
      }
    },
    [t],
  );

  const handleOpenRemoteFiles = useCallback((machine: SshMachine) => {
    openRemoteFiles(machine.id, machine.defaultPath);
    useRightDockStore.setState((state) => ({
      visible: true,
      activeView: "sshFiles",
      width: Math.max(state.width, 500),
    }));
  }, [openRemoteFiles]);

  const completeConnection = useCallback(
    (machine: SshMachine) => {
      onOpenTerminal(buildTerminalOpts(machine));
      handleOpenRemoteFiles(machine);
    },
    [handleOpenRemoteFiles, onOpenTerminal],
  );

  const handleConnect = useCallback((machine: SshMachine) => {
    if (
      machine.authMethod === "password"
      && !machine.hasStoredPassword
      && !hasSessionPassword(machine.id)
    ) {
      setPendingConnectionMachine(machine);
      return;
    }
    completeConnection(machine);
  }, [completeConnection, hasSessionPassword]);

  const handleConnectionPasswordReady = useCallback(async (remember: boolean) => {
    if (!pendingConnectionMachine) return;
    markSessionPassword(pendingConnectionMachine.id);
    if (remember) await load();
    completeConnection(pendingConnectionMachine);
    setPendingConnectionMachine(null);
  }, [completeConnection, load, markSessionPassword, pendingConnectionMachine]);

  const favoriteMachineIdSet = useMemo(
    () => new Set(favoriteMachineIds),
    [favoriteMachineIds],
  );
  const tags = useMemo(
    () =>
      Array.from(new Set(machines.flatMap((machine) => machine.tags))).sort(
        (left, right) => left.localeCompare(right),
      ),
    [machines],
  );
  const visibleMachines = useMemo(() => {
    return machines
      .filter((machine) => {
        if (favoritesOnly && !favoriteMachineIdSet.has(machine.id)) return false;
        if (activeTag && !machine.tags.includes(activeTag)) return false;
        return true;
      })
      .sort((left, right) => {
        const favoriteDifference =
          Number(favoriteMachineIdSet.has(right.id)) -
          Number(favoriteMachineIdSet.has(left.id));
        return favoriteDifference || left.name.localeCompare(right.name);
      });
  }, [activeTag, favoriteMachineIdSet, favoritesOnly, machines]);
  const groupedMachines = useMemo(() => {
    const groups = new Map<string, SshMachine[]>();
    for (const machine of visibleMachines) {
      const group = activeTag || machine.tags[0] || "__untagged__";
      groups.set(group, [...(groups.get(group) ?? []), machine]);
    }
    return [...groups.entries()].sort(([left], [right]) => {
      if (left === "__untagged__") return 1;
      if (right === "__untagged__") return -1;
      return left.localeCompare(right);
    });
  }, [activeTag, visibleMachines]);
  const onlineMachineCount = useMemo(
    () =>
      machines.filter((machine) => {
        const state = connectivity[machine.id];
        return state !== "checking" && !!state?.reachable;
      }).length,
    [connectivity, machines],
  );
  const favoriteCount = favoriteMachineIds.filter((id) =>
    machines.some((machine) => machine.id === id),
  ).length;

  const selectAllMachines = useCallback(() => {
    setFavoritesOnly(false);
    setActiveTag(null);
  }, []);

  const selectFavorites = useCallback(() => {
    setFavoritesOnly(true);
    setActiveTag(null);
  }, []);

  const selectTag = useCallback((tag: string) => {
    setFavoritesOnly(false);
    setActiveTag(tag);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <SshMachinesHeader
        machineCount={machines.length}
        checkingAll={checkingAll}
        showWslDiscovery={isWindows}
        onCheckAll={() => void checkAll()}
        onDiscoverWsl={() => setWslDialogOpen(true)}
        onAdd={handleAdd}
      />

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {machines.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Server
              className="w-8 h-8"
              style={{ color: "var(--app-text-muted)" }}
            />
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
          <div className="flex flex-col gap-2">
            <div
              className="grid grid-cols-3 border-y py-1.5"
              style={{ borderColor: "var(--app-border)" }}
            >
              <SummaryMetric
                label={t("ssh.summaryMachines", { defaultValue: "Machines" })}
                value={machines.length}
              />
              <SummaryMetric
                label={t("ssh.summaryOnline", { defaultValue: "Online" })}
                value={onlineMachineCount}
                icon={onlineMachineCount > 0 ? Wifi : Radio}
              />
              <SummaryMetric
                label={t("ssh.summaryFavorites", { defaultValue: "Favorites" })}
                value={favoriteCount}
                icon={Star}
              />
            </div>
            <div
              className="flex gap-1 overflow-x-auto pb-0.5"
              aria-label={t("ssh.filters", { defaultValue: "Machine filters" })}
            >
              <FilterButton active={!favoritesOnly && activeTag === null} onClick={selectAllMachines}>
                {t("ssh.filterAll", { defaultValue: "All" })}
                <span>{machines.length}</span>
              </FilterButton>
              <FilterButton active={favoritesOnly} onClick={selectFavorites}>
                <Star className="h-3 w-3" fill={favoriteCount > 0 ? "currentColor" : "none"} />
                {t("ssh.favorites", { defaultValue: "Favorites" })}
                <span>{favoriteCount}</span>
              </FilterButton>
              {tags.map((tag) => (
                <FilterButton
                  key={tag}
                  active={!favoritesOnly && activeTag === tag}
                  onClick={() => selectTag(tag)}
                >
                  {tag}
                </FilterButton>
              ))}
            </div>
            {visibleMachines.length === 0 ? (
              <p
                className="py-6 text-center text-xs"
                style={{ color: "var(--app-text-muted)" }}
              >
                {t("ssh.noMatches", { defaultValue: "No matching machines" })}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {groupedMachines.map(([group, groupMachines]) => (
                  <section
                    key={group}
                    className="flex flex-col gap-1"
                    aria-label={
                      group === "__untagged__"
                        ? t("ssh.ungrouped", { defaultValue: "Ungrouped" })
                        : group
                    }
                  >
                    <div className="flex items-center justify-between px-1">
                      <span
                        className="text-[10px] font-medium"
                        style={{ color: "var(--app-text-secondary)" }}
                      >
                        {group === "__untagged__"
                          ? t("ssh.ungrouped", { defaultValue: "Ungrouped" })
                          : group}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      {groupMachines.map((machine) => (
                        <MachineItem
                          key={machine.id}
                          machine={machine}
                          connectivity={connectivity[machine.id] ?? null}
                          favorite={favoriteMachineIdSet.has(machine.id)}
                          onConnect={handleConnect}
                          onOpenFiles={handleOpenRemoteFiles}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onCopy={handleCopyConnectionInfo}
                          onCheckConnectivity={checkOne}
                          onToggleFavorite={toggleFavorite}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 对话框 */}
      <SshMachineDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        machine={editMachine}
      />
      <SshPasswordDialog
        machine={pendingConnectionMachine}
        open={pendingConnectionMachine !== null}
        onOpenChange={(open) => !open && setPendingConnectionMachine(null)}
        onConnected={handleConnectionPasswordReady}
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
