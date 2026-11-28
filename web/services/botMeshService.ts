// Bot 组网（docs/112 §5）的 invoke 封装。只在桌面端可用（服务在 Tauri 侧）。
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauriRuntime, listenIfTauri } from "./runtime";
import {
  MESH_OUTBOX_CHANGED_EVENT,
  type ContactsView,
  type DiscoveryReport,
  type MeshAddressSource,
  type MeshPeer,
  type OutboxEntry,
  type RemotePatch,
  type SharedBot,
} from "@/types/botMesh";

const EMPTY_CONTACTS: ContactsView = { deviceName: "", groups: [] };

export const botMeshService = {
  contacts: async (refresh = false): Promise<ContactsView> =>
    isTauriRuntime() ? invoke<ContactsView>("mesh_contacts", { refresh }) : EMPTY_CONTACTS,
  peers: async (): Promise<MeshPeer[]> => (isTauriRuntime() ? invoke<MeshPeer[]>("mesh_peers") : []),
  discover: async (): Promise<DiscoveryReport> => invoke<DiscoveryReport>("mesh_discover"),
  pair: async (name: string, baseUrl: string, code: string, source?: MeshAddressSource): Promise<void> =>
    invoke("mesh_pair_peer", { name, baseUrl, code, source }),
  removePeer: async (deviceId: string): Promise<void> => invoke("mesh_remove_peer", { deviceId }),
  send: async (deviceId: string, botId: string, text: string): Promise<OutboxEntry> =>
    invoke<OutboxEntry>("mesh_send", { deviceId, botId, text }),
  outbox: async (): Promise<OutboxEntry[]> => (isTauriRuntime() ? invoke<OutboxEntry[]>("mesh_outbox") : []),
  clearOutbox: async (id: string): Promise<void> => invoke("mesh_clear_outbox", { id }),
  respondPermission: async (deviceId: string, botId: string, requestKey: string, optionId: string | null): Promise<void> =>
    invoke("mesh_respond_permission", { deviceId, botId, requestKey, optionId }),
  setBotRemote: async (botId: string, patch: RemotePatch): Promise<SharedBot> =>
    invoke<SharedBot>("mesh_set_bot_remote", { botId, patch }),
  listenOutbox: (handler: (entry: OutboxEntry) => void): Promise<UnlistenFn> =>
    listenIfTauri<OutboxEntry>(MESH_OUTBOX_CHANGED_EVENT, (event) => handler(event.payload)),
};
