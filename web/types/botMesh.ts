// Bot 组网（docs/112 §5）：Rust services/bot_mesh 的镜像。
import type { RemotePolicy } from "./bot";

export const MESH_OUTBOX_CHANGED_EVENT = "bot-mesh-outbox-changed";
export const LOCAL_DEVICE = "local";

/** `/api/bots` 条目：不含完整人设。 */
export interface SharedBot {
  id: string;
  name: string;
  avatar: string;
  color: string;
  engineId: string;
  personaSummary: string;
  /** idle / starting / ready / generating / exited / failed */
  status: string;
  remotePolicy: RemotePolicy;
  remoteAllowKinds: string[];
  remoteShared: boolean;
  chatId: string;
}

export type ContactGroupStatus = "online" | "offline" | "unauthorized" | "unsupported" | "error";

export interface ContactGroup {
  deviceId: string;
  name: string;
  local: boolean;
  status: ContactGroupStatus;
  online: boolean;
  error?: string;
  address?: string;
  instanceId?: string;
  lastSeenAt?: string;
  bots: SharedBot[];
}

export interface ContactsView {
  instanceId?: string | null;
  deviceName: string;
  groups: ContactGroup[];
}

export type MeshAddressSource = "lan" | "tailscale" | "manual";

export interface MeshAddress {
  url: string;
  source: MeshAddressSource;
  lastOkAt?: string;
}

export interface MeshPeer {
  deviceId: string;
  name: string;
  kind: "direct" | "ssh";
  targetLabel: string;
  hasToken: boolean;
  instanceId?: string;
  hostname?: string;
  addresses: MeshAddress[];
  preferredUrl?: string;
  lastSeenAt?: string;
  lastError?: string;
}

export interface DiscoveredNode {
  source: MeshAddressSource;
  name: string;
  instanceId?: string;
  version?: string;
  addresses: string[];
  online: boolean;
  reachable: boolean;
  pairedDeviceId?: string;
}

export interface DiscoveryReport {
  nodes: DiscoveredNode[];
  /** running / notInstalled / stopped / error */
  tailscale: string;
  /** ok / error:<原因> */
  mdns: string;
  advertising: boolean;
}

export type MeshMessageStatus = "queued" | "running" | "waiting_permission" | "done" | "failed";

export interface PendingPermission {
  requestKey: string;
  params: {
    toolCall?: { toolCallId?: string; title?: string; kind?: string };
    options?: { optionId: string; name?: string; kind?: string }[];
  } & Record<string, unknown>;
}

export interface OutboxEntry {
  id: string;
  deviceId: string;
  deviceName: string;
  botId: string;
  botName: string;
  text: string;
  traceId: string;
  hops: number;
  sender: string;
  status: MeshMessageStatus;
  reply?: string;
  error?: { code: string; message: string };
  pendingPermissions: PendingPermission[];
  createdAt: number;
  updatedAt: number;
}

export interface RemotePatch {
  remotePolicy?: RemotePolicy;
  remoteAllowKinds?: string[];
  remoteShared?: boolean;
  confirmFull?: boolean;
}

export function isTerminalStatus(status: MeshMessageStatus): boolean {
  return status === "done" || status === "failed";
}

/** 联系人「在线」点：本机 Bot 看运行相位，远程电脑看分组状态。 */
export function botIsLive(status: string): boolean {
  return status === "ready" || status === "generating" || status === "starting";
}

/** 新的发件 / 状态更新合并进列表（按 id 覆盖，新 → 旧）。 */
export function mergeOutbox(list: OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
  const rest = list.filter((item) => item.id !== entry.id);
  return [entry, ...rest].sort((a, b) => b.createdAt - a.createdAt);
}
