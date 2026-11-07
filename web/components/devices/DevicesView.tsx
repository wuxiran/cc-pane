// 侧栏「设备」：其他运行 CC-Panes 的服务器 / 电脑，显示在线状态、CLI 安装情况、
// 工作空间和运行中的会话。docs/111-multi-device.md
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getVersion } from "@tauri-apps/api/app";
import { Plus, RefreshCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  sidebarSectionCountClass,
  sidebarSectionHeaderClass,
  sidebarSectionTitleClass,
} from "@/components/sidebar/sidebarStyles";
import { useDevicesStore } from "@/stores/useDevicesStore";
import { onDeployProgress } from "@/services/deviceService";
import { nativeConfirm } from "@/services/nativeDialog";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import type { DeviceSummary } from "@/types/device";
import AddDeviceDialog from "./AddDeviceDialog";
import DeviceCard from "./DeviceCard";
import DeviceTokenDialog from "./DeviceTokenDialog";

const POLL_INTERVAL_MS = 10_000;

function HeaderButton({ label, onClick, children, disabled }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--app-hover)] disabled:opacity-40"
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export default function DevicesView() {
  const { t } = useTranslation("sidebar");
  const devices = useDevicesStore((s) => s.devices);
  const loaded = useDevicesStore((s) => s.loaded);
  const load = useDevicesStore((s) => s.load);
  const refresh = useDevicesStore((s) => s.refresh);
  const refreshAll = useDevicesStore((s) => s.refreshAll);
  const refreshing = useDevicesStore((s) => s.refreshing);
  const deploy = useDevicesStore((s) => s.deploy);
  const remove = useDevicesStore((s) => s.remove);
  const applyDeployProgress = useDevicesStore((s) => s.applyDeployProgress);

  const [addOpen, setAddOpen] = useState(false);
  const [tokenDevice, setTokenDevice] = useState<DeviceSummary | null>(null);
  const [localVersion, setLocalVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    getVersion().then(setLocalVersion).catch(() => {});
    let unlisten: (() => void) | undefined;
    let disposed = false;
    onDeployProgress(applyDeployProgress).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyDeployProgress]);

  // 视图可见时加载并轮询；卸载即停止（侧栏切走就不再打对方）。
  useEffect(() => {
    let cancelled = false;
    load()
      .then(() => {
        if (!cancelled) void useDevicesStore.getState().refreshAll();
      })
      .catch((error) => toast.error(getErrorMessage(error)));
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void useDevicesStore.getState().refreshAll();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [load]);

  const runDeploy = useCallback(async (device: DeviceSummary) => {
    try {
      const report = await deploy(device.id);
      toast.success(t("devices.deployed", { name: device.name, version: report.version }));
      for (const warning of report.warnings) toast.warning(warning, { duration: 12_000 });
    } catch (error) {
      toast.error(t("devices.deployFailed", { error: getErrorMessage(error) }), { duration: 15_000 });
    }
  }, [deploy, t]);

  const handleRemove = useCallback(async (device: DeviceSummary) => {
    const confirmed = await nativeConfirm(t("devices.removeConfirm", { name: device.name }));
    if (!confirmed) return;
    try {
      await remove(device.id);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }, [remove, t]);

  const anyRefreshing = Object.values(refreshing).some(Boolean);

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="devices-view">
      <div className={sidebarSectionHeaderClass}>
        <div className="flex items-center gap-2">
          <span className={sidebarSectionTitleClass}>{t("devices.title")}</span>
          <span
            className={sidebarSectionCountClass}
            style={{ background: "color-mix(in srgb, var(--app-text-primary) 8%, transparent)" }}
          >
            {devices.length}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {devices.length > 0 && (
            <HeaderButton label={t("devices.refresh")} onClick={() => void refreshAll()} disabled={anyRefreshing}>
              <RefreshCw
                className={`h-3.5 w-3.5 ${anyRefreshing ? "animate-spin" : ""}`}
                style={{ color: "var(--app-text-secondary)" }}
              />
            </HeaderButton>
          )}
          <HeaderButton label={t("devices.add")} onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" style={{ color: "var(--app-text-secondary)" }} />
          </HeaderButton>
        </div>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {loaded && devices.length === 0 ? (
          <div className="mx-1 mt-2 flex flex-col gap-2 rounded-lg border border-dashed px-3 py-4 text-xs leading-relaxed"
            style={{ borderColor: "var(--app-border)", color: "var(--app-text-tertiary)" }}
          >
            <p>{t("devices.empty")}</p>
            <button
              type="button"
              className="self-start rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-[var(--app-hover)]"
              style={{ color: "var(--app-accent)" }}
              onClick={() => setAddOpen(true)}
            >
              + {t("devices.add")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                localVersion={localVersion}
                onRefresh={() => void refresh(device.id)}
                onDeploy={() => void runDeploy(device)}
                onUpdateToken={() => setTokenDevice(device)}
                onRemove={() => void handleRemove(device)}
              />
            ))}
          </div>
        )}
      </div>

      <AddDeviceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={(device, deployNow) => {
          if (deployNow) void runDeploy(device);
          else void refresh(device.id);
        }}
      />
      <DeviceTokenDialog device={tokenDevice} onClose={() => setTokenDevice(null)} />
    </div>
  );
}
