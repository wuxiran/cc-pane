import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SshConnectionInfo } from "@/types";

/** 与 Rust `PortPreviewTunnel` 对齐 */
export interface PortPreviewTunnel {
  id: string;
  sessionId: string;
  sshHost: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
  createdAt: number;
}

export interface OpenPortPreviewRequest {
  sessionId: string;
  ssh: SshConnectionInfo;
  remoteHost: string;
  remotePort: number;
}

export const PORT_PREVIEW_CHANGED_EVENT = "port-preview-changed";

/** 远程端口本机预览（SSH 本地端口转发）。仅桌面端：Web 壳没有本机可转发。 */
export const portPreviewService = {
  open(request: OpenPortPreviewRequest): Promise<PortPreviewTunnel> {
    return invoke<PortPreviewTunnel>("open_port_preview", { ...request });
  },
  list(): Promise<PortPreviewTunnel[]> {
    return invoke<PortPreviewTunnel[]>("list_port_previews");
  },
  close(id: string): Promise<boolean> {
    return invoke<boolean>("close_port_preview", { id });
  },
  onChanged(handler: () => void): Promise<UnlistenFn> {
    return listen(PORT_PREVIEW_CHANGED_EVENT, handler);
  },
};
