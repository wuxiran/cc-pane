import { apiDelete, apiGet, apiJson, invokeOrApi, isTauriRuntime } from "./apiClient";
import type {
  SshMachine,
  SshConnectivityResult,
  SshMachineUpsertRequest,
  WslDistro,
} from "@/types";

export async function listSshMachines(): Promise<SshMachine[]> {
  return invokeOrApi<SshMachine[]>("list_ssh_machines", undefined, () =>
    apiGet<SshMachine[]>("/api/ssh-machines"),
  );
}

export async function getSshMachine(id: string): Promise<SshMachine | null> {
  return invokeOrApi<SshMachine | null>("get_ssh_machine", { id }, () =>
    apiGet<SshMachine | null>(`/api/ssh-machines/${encodeURIComponent(id)}`),
  );
}

export async function addSshMachine(
  request: SshMachineUpsertRequest,
): Promise<SshMachine> {
  return invokeOrApi<SshMachine>("add_ssh_machine", { request }, () =>
    apiJson<SshMachine>("/api/ssh-machines", "POST", request),
  );
}

export async function updateSshMachine(
  request: SshMachineUpsertRequest,
): Promise<SshMachine> {
  return invokeOrApi<SshMachine>("update_ssh_machine", { request }, () =>
    apiJson<SshMachine>("/api/ssh-machines", "PUT", request),
  );
}

export async function removeSshMachine(id: string): Promise<void> {
  return invokeOrApi<void>("remove_ssh_machine", { id }, () =>
    apiDelete(`/api/ssh-machines/${encodeURIComponent(id)}`),
  );
}

export async function checkSshConnectivity(
  id: string,
): Promise<SshConnectivityResult> {
  return invokeOrApi<SshConnectivityResult>("check_ssh_connectivity", { id }, () =>
    apiJson<SshConnectivityResult>(
      `/api/ssh-machines/${encodeURIComponent(id)}/check`,
      "POST",
    ),
  );
}

/** 发现已安装的 WSL 分发版（仅 Windows，其他平台返回空数组） */
export async function discoverWslDistros(): Promise<WslDistro[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return invokeOrApi<WslDistro[]>("discover_wsl_distros", undefined, async () => []);
}
