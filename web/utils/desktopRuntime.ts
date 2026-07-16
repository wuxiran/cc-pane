import { waitForTauri } from "@/utils";
import { isTauriRuntime } from "@/services/runtime";
import type { OpenTerminalOptions } from "@/types";

export function resolveRuntimeKind(opts: Pick<OpenTerminalOptions, "ssh" | "wsl">): string {
  if (opts.ssh) return "ssh";
  if (opts.wsl) return "wsl";
  return "local";
}

/** 等待桌面运行时就绪；Web 运行时直接就绪。 */
export async function waitForDesktopRuntime(): Promise<boolean> {
  return isTauriRuntime() ? waitForTauri() : true;
}
