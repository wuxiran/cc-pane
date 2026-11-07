// 设备：其他运行 CC-Panes 的服务器 / 电脑（docs/111-multi-device.md）。
// 只在桌面端可用：SSH 隧道、keyring 里的设备令牌都在 Tauri 后端。
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  DeployProgress,
  DeployReport,
  DeviceAddRequest,
  DeviceSnapshot,
  DeviceSummary,
} from "@/types/device";
import { invokeOrApi } from "./apiClient";
import { listenIfTauri } from "./runtime";

const DESKTOP_ONLY = () => Promise.reject(new Error("Devices are only available in the desktop app"));

export function listDevices(): Promise<DeviceSummary[]> {
  return invokeOrApi<DeviceSummary[]>("device_list", undefined, async () => []);
}

export function addDevice(request: DeviceAddRequest): Promise<DeviceSummary> {
  return invokeOrApi<DeviceSummary>("device_add", { request }, DESKTOP_ONLY);
}

export function renameDevice(id: string, name: string): Promise<void> {
  return invokeOrApi<void>("device_rename", { id, name }, DESKTOP_ONLY);
}

export function removeDevice(id: string): Promise<void> {
  return invokeOrApi<void>("device_remove", { id }, DESKTOP_ONLY);
}

export function setDeviceToken(id: string, token: string): Promise<void> {
  return invokeOrApi<void>("device_set_token", { id, token }, DESKTOP_ONLY);
}

export function getDeviceSnapshot(id: string): Promise<DeviceSnapshot> {
  return invokeOrApi<DeviceSnapshot>("device_snapshot", { id }, DESKTOP_ONLY);
}

export function deployDevice(id: string): Promise<DeployReport> {
  return invokeOrApi<DeployReport>("device_deploy", { id }, DESKTOP_ONLY);
}

export function onDeployProgress(handler: (progress: DeployProgress) => void): Promise<UnlistenFn> {
  return listenIfTauri<DeployProgress>("device-deploy-progress", (event) => handler(event.payload));
}

export interface DeviceSessionRequest {
  projectPath: string;
  workspaceName?: string;
  workspacePath?: string;
  /** "claude" / "codex" / … ；"none" = 纯 shell */
  cliTool: string;
  cols: number;
  rows: number;
}

/** 在设备上新建会话，返回对端的会话 id（随后用 adoptSession 打开标签）。 */
export function createDeviceSession(id: string, request: DeviceSessionRequest): Promise<string> {
  return invokeOrApi<string>("device_create_session", { id, request }, DESKTOP_ONLY);
}

/** 登记设备上已在运行的会话，随后用 adoptSession 打开标签。 */
export function attachDeviceSession(id: string, sessionId: string): Promise<void> {
  return invokeOrApi<void>("device_attach_session", { id, sessionId }, DESKTOP_ONLY);
}
