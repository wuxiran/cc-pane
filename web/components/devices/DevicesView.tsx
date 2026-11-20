// 侧栏「设备」：我能连到的机器。SSH 主机（开终端 / 远程文件）与其他电脑上的 CC-Panes
// 合并在一个视图里——同一台 SSH 主机上部署了 CC-Panes 时，它的状态、会话和工作空间直接挂在
// 那台主机的条目下；配对码 / 地址直连的其他电脑单独成一段。docs/111-multi-device.md
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MonitorSmartphone } from "lucide-react";
import SshMachinesView, { type MachineDevicesSlot } from "@/components/sidebar/SshMachinesView";
import { useSshMachineDialogStore, useSshMachinesStore } from "@/stores";
import { useDevicesStore } from "@/stores/useDevicesStore";
import type { OpenTerminalOptions } from "@/types";
import type { DeviceSummary } from "@/types/device";
import AddDeviceDialog from "./AddDeviceDialog";
import DeviceCard from "./DeviceCard";
import DeviceTokenDialog from "./DeviceTokenDialog";
import { useDevicesController, type AddDeviceRequest } from "./useDevicesController";

interface DevicesViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

function TextButton({ children, onClick, testId }: {
  children: React.ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="self-start rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-[var(--app-hover)]"
      style={{ color: "var(--app-accent)" }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function openSshMachineDialog() {
  useSshMachineDialogStore.getState().openAddDialog();
}

export default function DevicesView({ onOpenTerminal }: DevicesViewProps) {
  const { t } = useTranslation("sidebar");
  const devices = useDevicesStore((s) => s.devices);
  const refreshing = useDevicesStore((s) => s.refreshing);
  const refreshAll = useDevicesStore((s) => s.refreshAll);
  const machines = useSshMachinesStore((s) => s.machines);
  const controller = useDevicesController();
  const { openAdd } = controller;

  // 按 SSH 主机归组；主机已被删掉的旧 SSH 设备落到「其他电脑」段，仍可查看和移除。
  const { byMachine, others } = useMemo(() => {
    const machineIds = new Set(machines.map((machine) => machine.id));
    const grouped = new Map<string, DeviceSummary[]>();
    const rest: DeviceSummary[] = [];
    for (const device of devices) {
      const { connection } = device;
      if (connection.kind === "ssh" && machineIds.has(connection.machineId)) {
        grouped.set(connection.machineId, [...(grouped.get(connection.machineId) ?? []), device]);
      } else {
        rest.push(device);
      }
    }
    return { byMachine: grouped, others: rest };
  }, [devices, machines]);

  const renderCard = (device: DeviceSummary, hostName?: string) => (
    <DeviceCard
      key={device.id}
      device={device}
      hostName={hostName}
      localVersion={controller.localVersion}
      onRefresh={() => void controller.refresh(device.id)}
      onDeploy={() => void controller.runDeploy(device)}
      onUpdateToken={() => controller.setTokenDevice(device)}
      onRemove={() => void controller.removeDevice(device)}
    />
  );

  const addDirect = () => openAdd({ kind: "direct" } satisfies AddDeviceRequest);

  const slot: MachineDevicesSlot = {
    title: t("machines.title"),
    otherCount: others.length,
    addOptions: [
      { id: "ssh-host", label: t("machines.addSshHost"), onSelect: openSshMachineDialog },
      { id: "ssh-device", label: t("machines.addSshCcPanes"), onSelect: () => openAdd({ kind: "ssh" }) },
      { id: "direct", label: t("machines.addOtherComputer"), onSelect: addDirect },
    ],
    renderForMachine: (machine) => byMachine.get(machine.id)?.map((device) => renderCard(device, machine.name)),
    canDeploy: (machineId) => !byMachine.has(machineId),
    onDeploy: (machine) => openAdd({ kind: "ssh", machineId: machine.id }),
    onRefreshAll: () => void refreshAll(),
    refreshing: Object.values(refreshing).some(Boolean),
    emptyState: (
      <div
        className="mx-1 mt-2 flex flex-col gap-2 rounded-lg border border-dashed px-3 py-4 text-xs leading-relaxed"
        style={{ borderColor: "var(--app-border)", color: "var(--app-text-tertiary)" }}
        data-testid="machines-empty"
      >
        <MonitorSmartphone className="h-6 w-6" style={{ color: "var(--app-text-muted)" }} />
        <p>{t("machines.empty")}</p>
        <TextButton onClick={openSshMachineDialog}>+ {t("machines.addSshHost")}</TextButton>
        <TextButton onClick={addDirect}>+ {t("machines.addOtherComputer")}</TextButton>
      </div>
    ),
    footer: others.length > 0 ? (
      <section className="mt-3 flex flex-col gap-1" aria-label={t("machines.otherComputers")}>
        <div className="flex items-center gap-1.5 px-1">
          <span className="text-[length:var(--text-micro)] font-medium" style={{ color: "var(--app-text-secondary)" }}>
            {t("machines.otherComputers")}
          </span>
          <span className="text-[length:var(--text-micro)] tabular-nums" style={{ color: "var(--app-text-tertiary)" }}>
            {others.length}
          </span>
        </div>
        {others.map((device) => renderCard(device))}
      </section>
    ) : machines.length > 0 ? (
      <div className="mt-3 flex">
        <TextButton onClick={addDirect} testId="machines-add-other-inline">
          + {t("machines.addOtherComputer")}
        </TextButton>
      </div>
    ) : null,
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="devices-view">
      <SshMachinesView onOpenTerminal={onOpenTerminal} devices={slot} />
      <AddDeviceDialog
        open={controller.addOpen}
        onOpenChange={controller.setAddOpen}
        initialKind={controller.addRequest.kind}
        initialMachineId={controller.addRequest.machineId}
        onAdded={controller.handleAdded}
      />
      <DeviceTokenDialog device={controller.tokenDevice} onClose={() => controller.setTokenDevice(null)} />
    </div>
  );
}
