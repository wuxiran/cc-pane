import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { activeTerminalLeaf } from "@/lib/paneSessions";
import { terminalService } from "@/services";
import { useActivityBarStore, usePanesStore } from "@/stores";
import type { FsEntry, Tab } from "@/types";
import { getErrorMessage } from "@/utils";

function activeSshShellSessionId(machineId: string): string | null {
  const pane = usePanesStore.getState().activePane();
  const tab = pane?.tabs.find((candidate) => candidate.id === pane.activeTabId);
  if (!tab || tab.contentType !== "terminal") return null;

  const leaf = activeTerminalLeaf(tab);
  const ssh = leaf?.ssh ?? tab.ssh;
  const cliTool = leaf?.cliTool ?? tab.cliTool;
  const sessionId = leaf?.sessionId ?? legacySessionId(tab);
  const unavailable = leaf
    ? leaf.disconnected || leaf.restoring || leaf.leaseReadOnly
    : tab.disconnected || tab.restoring || tab.leaseReadOnly;
  if (ssh?.machineId !== machineId || (cliTool && cliTool !== "none") || unavailable) {
    return null;
  }
  return sessionId;
}

function legacySessionId(tab: Tab): string | null {
  return tab.terminalRootPane ? null : tab.sessionId;
}

export function buildRemoteCdCommand(path: string): string {
  return `cd '${path.replace(/'/g, `'"'"'`)}'`;
}

export function useSshRemoteTerminalNavigation(machineId: string | null) {
  const { t } = useTranslation("sidebar");
  return useCallback(async (entry: FsEntry) => {
    if (!machineId || !entry.isDir) return;
    const sessionId = activeSshShellSessionId(machineId);
    if (!sessionId) {
      toast.error(t("sshFiles.noActiveShell"));
      return;
    }
    try {
      await terminalService.submitToSession(sessionId, buildRemoteCdCommand(entry.path));
      // 不弹「终端已切换到…」toast：界面已切到 panes 视图，终端里能看到 cd 命令（见 docs/feedback-channels.md）。
      useActivityBarStore.setState({ appViewMode: "panes", orchestrationOverlayOpen: false });
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }, [machineId, t]);
}
