import type { OpenTerminalOptions, SshMachine } from "@/types";
import type { SshConnectionInfo } from "@/types/workspace";

/** 从 SshMachine 构造 OpenTerminalOptions */
export function buildTerminalOpts(m: SshMachine): OpenTerminalOptions {
  const remotePath = m.defaultPath || "~";
  const ssh: SshConnectionInfo = {
    host: m.host,
    port: m.port,
    user: m.user,
    remotePath,
    identityFile: m.identityFile,
    machineId: m.id,
    authMethod: m.authMethod,
  };
  const userPart = m.user ? `${m.user}@` : "";
  const portPart = m.port !== 22 ? `:${m.port}` : "";
  const path = `ssh://${userPart}${m.host}${portPart}/${remotePath}`;
  return { path, ssh, machineName: m.name };
}
