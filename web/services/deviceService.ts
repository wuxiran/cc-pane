// 设备：其他运行 CC-Panes 的服务器 / 电脑（docs/111-multi-device.md）。
// 只在桌面端可用：SSH 隧道、keyring 里的设备令牌都在 Tauri 后端。
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  DeployProgress,
  DeployReport,
  DeviceAddRequest,
  DeviceSnapshot,
  DeviceSummary,
  LocalDeviceInfo,
} from "@/types/device";
import { invokeOrApi } from "./apiClient";
import { listenIfTauri } from "./runtime";

const DESKTOP_ONLY = () => Promise.reject(new Error("Devices are only available in the desktop app"));

/** 本机主机名 / 系统 / 版本。Web 端没有对应命令，返回 null 由界面退回 UA 推断。 */
export function getLocalDeviceInfo(): Promise<LocalDeviceInfo | null> {
  return invokeOrApi<LocalDeviceInfo | null>("get_local_device_info", undefined, async () => null);
}

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

/** 用对方给出的配对码换令牌，并把对方添加为直连设备。 */
export function pairDevice(name: string, baseUrl: string, code: string): Promise<DeviceSummary> {
  return invokeOrApi<DeviceSummary>("device_pair", { name, baseUrl, code }, DESKTOP_ONLY);
}

export interface PairingInfo {
  code: string;
  expiresAt: string;
  addresses: string[];
}

export interface DeviceAccessRecord {
  id: string;
  name: string;
  hint: string;
  createdAt: string;
  /** 过期时间；null = 永不过期（老令牌 / 命令行建的令牌） */
  expiresAt?: string | null;
  expired?: boolean;
  /** 最后一次用令牌访问本机的时间（每分钟至多记录一次） */
  lastSeenAt?: string | null;
  lastIp?: string | null;
}

/**
 * 本机作为被连接方：生成一次性配对码。
 * `tokenTtlDays`：兑换出的令牌有效期；不传 = 默认 90 天，0 = 永不过期。
 */
export function startDevicePairing(tokenTtlDays?: number): Promise<PairingInfo> {
  return invokeOrApi<PairingInfo>(
    "device_access_pairing_start",
    tokenTtlDays === undefined ? undefined : { tokenTtlDays },
    DESKTOP_ONLY,
  );
}

export function cancelDevicePairing(): Promise<void> {
  return invokeOrApi<void>("device_access_pairing_cancel", undefined, DESKTOP_ONLY);
}

/** 哪些设备可以访问本机。 */
export function listDeviceAccess(): Promise<DeviceAccessRecord[]> {
  return invokeOrApi<DeviceAccessRecord[]>("device_access_list", undefined, async () => []);
}

export function revokeDeviceAccess(id: string): Promise<void> {
  return invokeOrApi<void>("device_access_revoke", { id }, DESKTOP_ONLY);
}
