import { apiJson, invokeOrApi } from "./apiClient";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauriRuntime } from "./runtime";

export type TerminalPathKind = "file" | "directory";
export type TerminalPathDesktopAction = "openDefault" | "reveal";

export interface ResolvedTerminalPathLink {
  canonicalPath: string;
  kind: TerminalPathKind;
  runtimeKind: "local" | "wsl";
}

export interface ResolveTerminalPathLinkInput {
  sessionId: string;
  rawPath: string;
}

export interface RunTerminalPathLinkActionInput extends ResolveTerminalPathLinkInput {
  action: TerminalPathDesktopAction;
}

function unsupportedWebAction(): Promise<never> {
  const error = new Error("Desktop path actions are unavailable in Web mode") as Error & {
    code: string;
  };
  error.code = "TERMINAL_PATH_ACTION_UNSUPPORTED";
  return Promise.reject(error);
}

export const terminalPathLinkService = {
  resolve(input: ResolveTerminalPathLinkInput): Promise<ResolvedTerminalPathLink> {
    return invokeOrApi<ResolvedTerminalPathLink>(
      "resolve_terminal_path_link",
      { ...input },
      () => apiJson<ResolvedTerminalPathLink>("/api/terminal/path-link/resolve", "POST", input),
    );
  },

  runDesktopAction(input: RunTerminalPathLinkActionInput): Promise<void> {
    return invokeOrApi<void>(
      "run_terminal_path_link_action",
      { ...input },
      unsupportedWebAction,
    );
  },

  async openExternalUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid external URL");
    }
    if (!parsed.host || !["http:", "https:"].includes(parsed.protocol)) {
      const error = new Error("Unsupported external URL") as Error & { code: string };
      error.code = "TERMINAL_LINK_SCHEME_UNSUPPORTED";
      throw error;
    }
    if (isTauriRuntime()) {
      await openUrl(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },
};
