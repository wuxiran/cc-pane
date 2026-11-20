// 「设备」视图里 CC-Panes 设备一侧的状态与操作：加载 + 轮询快照、部署进度、部署 / 移除 / 更新令牌。
// docs/111-multi-device.md
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "@/components/ui/toast";
import { useDevicesStore } from "@/stores/useDevicesStore";
import { onDeployProgress } from "@/services/deviceService";
import { nativeConfirm } from "@/services/nativeDialog";
import { isTauriRuntime } from "@/services/runtime";
import { getErrorMessage } from "@/utils";
import type { DeviceSummary } from "@/types/device";

const POLL_INTERVAL_MS = 10_000;

export type AddDeviceKind = "ssh" | "direct";

export interface AddDeviceRequest {
  kind: AddDeviceKind;
  machineId?: string;
}

export function useDevicesController() {
  const { t } = useTranslation("sidebar");
  const load = useDevicesStore((s) => s.load);
  const refresh = useDevicesStore((s) => s.refresh);
  const deploy = useDevicesStore((s) => s.deploy);
  const remove = useDevicesStore((s) => s.remove);
  const applyDeployProgress = useDevicesStore((s) => s.applyDeployProgress);

  // 请求在关闭后保留，避免对话框关闭动画期间类型跳回默认值
  const [addRequest, setAddRequest] = useState<AddDeviceRequest>({ kind: "ssh" });
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

  const removeDevice = useCallback(async (device: DeviceSummary) => {
    const confirmed = await nativeConfirm(t("devices.removeConfirm", { name: device.name }));
    if (!confirmed) return;
    try {
      await remove(device.id);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }, [remove, t]);

  const handleAdded = useCallback((device: DeviceSummary, deployNow: boolean) => {
    if (deployNow) void runDeploy(device);
    else void refresh(device.id);
  }, [refresh, runDeploy]);

  return {
    localVersion,
    addRequest,
    addOpen,
    openAdd: (request: AddDeviceRequest) => {
      setAddRequest(request);
      setAddOpen(true);
    },
    setAddOpen,
    handleAdded,
    tokenDevice,
    setTokenDevice,
    runDeploy,
    removeDevice,
    refresh,
  };
}
