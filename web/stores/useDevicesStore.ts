// 设备列表 + 每台设备的最新快照 + 部署进度（docs/111-multi-device.md）。
import { create } from "zustand";
import * as deviceService from "@/services/deviceService";
import type {
  DeployProgress,
  DeployReport,
  DeviceAddRequest,
  DeviceSnapshot,
  DeviceSummary,
} from "@/types/device";
import { getErrorMessage } from "@/utils";

interface DevicesState {
  devices: DeviceSummary[];
  loaded: boolean;
  snapshots: Record<string, DeviceSnapshot>;
  refreshing: Record<string, boolean>;
  deploying: Record<string, DeployProgress | null>;
  load: () => Promise<void>;
  refresh: (id: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  add: (request: DeviceAddRequest) => Promise<DeviceSummary>;
  remove: (id: string) => Promise<void>;
  setToken: (id: string, token: string) => Promise<void>;
  deploy: (id: string) => Promise<DeployReport>;
  applyDeployProgress: (progress: DeployProgress) => void;
}

function offlineSnapshot(deviceId: string, error: unknown): DeviceSnapshot {
  return {
    deviceId,
    online: false,
    errorKind: "error",
    error: getErrorMessage(error),
    info: null,
    environment: null,
    workspaces: null,
    sessions: null,
    launches: null,
  };
}

export const useDevicesStore = create<DevicesState>((set, get) => ({
  devices: [],
  loaded: false,
  snapshots: {},
  refreshing: {},
  deploying: {},

  load: async () => {
    const devices = await deviceService.listDevices();
    set({ devices, loaded: true });
  },

  refresh: async (id) => {
    if (get().refreshing[id]) return;
    set((s) => ({ refreshing: { ...s.refreshing, [id]: true } }));
    let snapshot: DeviceSnapshot;
    try {
      snapshot = await deviceService.getDeviceSnapshot(id);
    } catch (error) {
      snapshot = offlineSnapshot(id, error);
    }
    set((s) => ({
      snapshots: { ...s.snapshots, [id]: snapshot },
      refreshing: { ...s.refreshing, [id]: false },
    }));
  },

  refreshAll: async () => {
    await Promise.all(get().devices.map((device) => get().refresh(device.id)));
  },

  add: async (request) => {
    const device = await deviceService.addDevice(request);
    set((s) => ({ devices: [...s.devices, device] }));
    return device;
  },

  remove: async (id) => {
    await deviceService.removeDevice(id);
    set((s) => {
      const { [id]: _snapshot, ...snapshots } = s.snapshots;
      return { devices: s.devices.filter((device) => device.id !== id), snapshots };
    });
  },

  setToken: async (id, token) => {
    await deviceService.setDeviceToken(id, token);
    await get().load();
    await get().refresh(id);
  },

  deploy: async (id) => {
    set((s) => ({
      deploying: { ...s.deploying, [id]: { deviceId: id, step: "connect", detail: null, fraction: null } },
    }));
    try {
      const report = await deviceService.deployDevice(id);
      await get().load();
      await get().refresh(id);
      return report;
    } finally {
      set((s) => ({ deploying: { ...s.deploying, [id]: null } }));
    }
  },

  // 只在部署进行中接收进度：命令返回后迟到的事件不能把"部署中"状态重新点亮。
  applyDeployProgress: (progress) => {
    set((s) => (s.deploying[progress.deviceId]
      ? { deploying: { ...s.deploying, [progress.deviceId]: progress } }
      : s));
  },
}));
