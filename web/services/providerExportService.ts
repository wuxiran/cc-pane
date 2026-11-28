// 「导出到手机」命令封装（docs/112 §6）。仅桌面（Tauri）可用：导出码只活在桌面进程内存里。
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ProviderExportCandidate,
  ProviderExportEvent,
  ProviderExportStatus,
  ProviderExportTicket,
} from "@/types/providerExport";
import { PROVIDER_EXPORT_EVENT } from "@/types/providerExport";

export const providerExportService = {
  candidates(): Promise<ProviderExportCandidate[]> {
    return invoke<ProviderExportCandidate[]>("provider_export_candidates");
  },
  start(providerIds: string[]): Promise<ProviderExportTicket> {
    return invoke<ProviderExportTicket>("provider_export_start", { providerIds });
  },
  async cancel(): Promise<void> {
    await invoke("provider_export_cancel");
  },
  status(): Promise<ProviderExportStatus> {
    return invoke<ProviderExportStatus>("provider_export_status");
  },
  listen(handler: (event: ProviderExportEvent) => void): Promise<UnlistenFn> {
    return listen<ProviderExportEvent>(PROVIDER_EXPORT_EVENT, (event) => handler(event.payload));
  },
};
