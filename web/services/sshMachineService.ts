import { invoke } from "@tauri-apps/api/core";
import type {
  SshMachine,
  SshConnectivityResult,
  SshMachineUpsertRequest,
  WslDistro,
} from "@/types";

export async function listSshMachines(): Promise<SshMachine[]> {
  return invoke<SshMachine[]>("list_ssh_machines");
}

export async function getSshMachine(id: string): Promise<SshMachine | null> {
  return invoke<SshMachine | null>("get_ssh_machine", { id });
}

export async function addSshMachine(
  request: SshMachineUpsertRequest,
): Promise<SshMachine> {
  return invoke<SshMachine>("add_ssh_machine", { request });
}

export async function updateSshMachine(
  request: SshMachineUpsertRequest,
): Promise<SshMachine> {
  return invoke<SshMachine>("update_ssh_machine", { request });
}

export async function removeSshMachine(id: string): Promise<void> {
  return invoke("remove_ssh_machine", { id });
}

export async function checkSshConnectivity(
  id: string,
): Promise<SshConnectivityResult> {
  return invoke<SshConnectivityResult>("check_ssh_connectivity", { id });
}

/** 发现已安装的 WSL 分发版（仅 Windows，其他平台返回空数组） */
export async function discoverWslDistros(): Promise<WslDistro[]> {
  return invoke<WslDistro[]>("discover_wsl_distros");
}
