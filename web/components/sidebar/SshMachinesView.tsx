import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/toast";
import { Server } from "lucide-react";
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
import MachineItem from "./SshMachineItem";
import SshMachineFilterRow from "./SshMachineFilterRow";
import {
  AUTO_PROBE_CONCURRENCY,
  resolveMachineCcPanesAction,
  runWithConcurrency,
  type ConnectivityState,
} from "./sshMachineProbe";
import SshMachinesHeader, { type HeaderAddOption } from "./SshMachinesHeader";
import WslDiscoverDialog from "./WslDiscoverDialog";
import type {
  SshCcPanesProbe,
  SshMachine,
  OpenTerminalOptions,
} from "@/types";
import { buildTerminalOpts } from "./sshMachineTerminal";
import { nativeConfirm } from "@/services/nativeDialog";

/** 检测当前是否为 Windows 平台 */
const isWindows = navigator.platform?.startsWith("Win") ?? false;

/** 机器达到这个数（即多于 5 台）才显示标签筛选条；少量机器时它只是噪音 */
const FILTER_ROW_MIN_MACHINES = 6;

/**
 * 「设备」合并视图注入的部分（docs/111）：每台 SSH 主机下挂它的 CC-Panes，
 * 列表之后是不经 SSH 的其他电脑。不传时就是纯 SSH 机器列表。
 */
export interface MachineDevicesSlot {
  title: string;
  /** 不挂在任何已保存 SSH 主机下的设备数（计入标题） */
  otherCount: number;
  addOptions: readonly HeaderAddOption[];
  renderForMachine: (machine: SshMachine) => ReactNode;
  /** 这台主机下是否已挂了 CC-Panes 设备（已挂则菜单不再给部署 / 连接） */
  hasLinkedDevice: (machineId: string) => boolean;
  /** 探测到 Linux / macOS 且未在跑 CC-Panes 时，菜单提供「部署 CC-Panes」 */
  onDeploy: (machine: SshMachine) => void;
  /** 探测到对方已在跑 CC-Panes 时，菜单提供「连接」（配对直连） */
  onConnectCcPanes: (machine: SshMachine, ccPanes: SshCcPanesProbe) => void;
  onRefreshAll: () => void;
  refreshing: boolean;
  /** 机器与其他电脑都为空时显示 */
  emptyState: ReactNode;
  footer: ReactNode;
}

interface SshMachinesViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  devices?: MachineDevicesSlot;
}

export default function SshMachinesView({
  onOpenTerminal,
  devices,
}: SshMachinesViewProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const machines = useSshMachinesStore((s) => s.machines);
  const load = useSshMachinesStore((s) => s.load);
  const removeMachine = useSshMachinesStore((s) => s.remove);
  const favoriteMachineIds = useSshMachinePreferencesStore(
    (s) => s.favoriteMachineIds,
  );
  const selectedMachineId = useSshMachinePreferencesStore((s) => s.selectedMachineId);
  const toggleFavorite = useSshMachinePreferencesStore((s) => s.toggleFavorite);
  const selectMachine = useSshMachinePreferencesStore((s) => s.selectMachine);
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
  // 已自动检测过的机器：每台只自动测一次，手动「检测连通性」不受影响
  const autoProbedRef = useRef<Set<string>>(new Set());
  const connectivityRef = useRef(connectivity);
  connectivityRef.current = connectivity;

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

  useEffect(() => {
    if (machines.length === 0) {
      if (selectedMachineId) selectMachine(null);
      return;
    }
    if (selectedMachineId && machines.some((machine) => machine.id === selectedMachineId)) {
      return;
    }
    selectMachine(machines[0]!.id);
  }, [machines, selectMachine, selectedMachineId]);

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

  /** 检测所有机器连通性（限并发，避免 SSH 连接爆发） */
  const checkAll = useCallback(async () => {
    if (checkingAll || machines.length === 0) return;
    setCheckingAll(true);
    abortRef.current = false;
    const ids = machines.map((m) => m.id);
    await runWithConcurrency(ids, AUTO_PROBE_CONCURRENCY, checkOne, () => abortRef.current);
    if (!abortRef.current) setCheckingAll(false);
  }, [checkingAll, machines, checkOne]);

  // 进入视图 / 新增机器后，自动检测还没有结果的机器（系统 + 是否在跑 CC-Panes 都靠它）
  useEffect(() => {
    const pending = machines
      .map((m) => m.id)
      .filter((id) => !autoProbedRef.current.has(id) && !connectivityRef.current[id]);
    if (pending.length === 0) return;
    const timer = setTimeout(() => {
      for (const id of pending) autoProbedRef.current.add(id);
      void runWithConcurrency(pending, AUTO_PROBE_CONCURRENCY, checkOne, () => abortRef.current);
    }, 500);
    return () => clearTimeout(timer);
  }, [machines, checkOne]);

  // 挂载时复位（严格模式双挂载会先跑一次清理）；卸载时中止 + 递增 generation
  useEffect(() => {
    abortRef.current = false;
    return () => {
      abortRef.current = true;
      generationRef.current += 1;
    };
  }, []);

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
      const confirmed = await nativeConfirm(
        t("ssh.confirmDelete", {
          defaultValue: 'Are you sure you want to delete "{{name}}"?',
          name: machine.name,
        }),
      );
      if (!confirmed) return;

      try {
        await removeMachine(machine.id);
        if (selectedMachineId === machine.id) selectMachine(null);
        toast.success(
          t("ssh.deleted", { defaultValue: "SSH machine deleted" }),
        );
      } catch (e) {
        toast.error(getErrorMessage(e));
      }
    },
    [removeMachine, selectMachine, selectedMachineId, t],
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

  const handleSelectMachine = useCallback((machine: SshMachine) => {
    selectMachine(machine.id);
  }, [selectMachine]);

  const completeConnection = useCallback(
    (machine: SshMachine) => {
      selectMachine(machine.id);
      onOpenTerminal(buildTerminalOpts(machine));
      handleOpenRemoteFiles(machine);
    },
    [handleOpenRemoteFiles, onOpenTerminal, selectMachine],
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
  // 筛选条隐藏时筛选一并失效，免得机器删到 5 台以下后还残留看不见的筛选
  const showFilters = machines.length >= FILTER_ROW_MIN_MACHINES;
  const effectiveTag = showFilters ? activeTag : null;
  const effectiveFavoritesOnly = showFilters && favoritesOnly;
  const visibleMachines = useMemo(() => {
    return machines
      .filter((machine) => {
        if (effectiveFavoritesOnly && !favoriteMachineIdSet.has(machine.id)) return false;
        if (effectiveTag && !machine.tags.includes(effectiveTag)) return false;
        return true;
      })
      .sort((left, right) => {
        const favoriteDifference =
          Number(favoriteMachineIdSet.has(right.id)) -
          Number(favoriteMachineIdSet.has(left.id));
        return favoriteDifference || left.name.localeCompare(right.name);
      });
  }, [effectiveTag, favoriteMachineIdSet, effectiveFavoritesOnly, machines]);
  const groupedMachines = useMemo(() => {
    const groups = new Map<string, SshMachine[]>();
    for (const machine of visibleMachines) {
      const group = effectiveTag || machine.tags[0] || "__untagged__";
      groups.set(group, [...(groups.get(group) ?? []), machine]);
    }
    return [...groups.entries()].sort(([left], [right]) => {
      if (left === "__untagged__") return 1;
      if (right === "__untagged__") return -1;
      return left.localeCompare(right);
    });
  }, [effectiveTag, visibleMachines]);
  const favoriteCount = favoriteMachineIds.filter((id) =>
    machines.some((machine) => machine.id === id),
  ).length;

  const ccPanesHandlers = (machine: SshMachine) => {
    if (!devices) return {};
    const action = resolveMachineCcPanesAction(
      devices.hasLinkedDevice(machine.id),
      connectivity[machine.id] ?? null,
    );
    if (action?.kind === "deploy") return { onDeployCcPanes: devices.onDeploy };
    if (action?.kind === "connect") return { onConnectCcPanes: devices.onConnectCcPanes };
    return {};
  };

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
        title={devices?.title}
        totalCount={devices ? machines.length + devices.otherCount : undefined}
        addOptions={devices?.addOptions}
        machineCount={machines.length}
        checkingAll={checkingAll || Boolean(devices?.refreshing)}
        showWslDiscovery={isWindows}
        onCheckAll={() => {
          void checkAll();
          devices?.onRefreshAll();
        }}
        onDiscoverWsl={() => setWslDialogOpen(true)}
        onAdd={handleAdd}
      />

      {/* 列表 */}
      <div className="app-scrollbar flex-1 overflow-y-auto px-2 pb-2">
        {machines.length === 0 && devices ? (
          devices.otherCount === 0 ? devices.emptyState : null
        ) : machines.length === 0 ? (
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
            {showFilters && (
              <SshMachineFilterRow
                machineCount={machines.length}
                favoriteCount={favoriteCount}
                tags={tags}
                activeTag={activeTag}
                favoritesOnly={favoritesOnly}
                onSelectAll={selectAllMachines}
                onSelectFavorites={selectFavorites}
                onSelectTag={selectTag}
              />
            )}
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
                        className="text-[length:var(--text-micro)] font-medium"
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
                          selected={selectedMachineId === machine.id}
                          onSelect={handleSelectMachine}
                          onConnect={handleConnect}
                          onOpenFiles={handleOpenRemoteFiles}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onCopy={handleCopyConnectionInfo}
                          onCheckConnectivity={checkOne}
                          onToggleFavorite={toggleFavorite}
                          {...ccPanesHandlers(machine)}
                        >
                          {devices?.renderForMachine(machine)}
                        </MachineItem>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
        {devices?.footer}
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
