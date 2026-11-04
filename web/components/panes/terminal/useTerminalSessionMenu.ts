import { useMemo } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { collectTerminalLeaves } from "@/lib/paneSessions";
import { agentTranscriptService } from "@/services/agentTranscriptService";
import { terminalForkSource } from "@/services/chatForkService";
import { isTauriRuntime } from "@/services/runtime";
import { usePanesStore } from "@/stores";
import { getErrorMessage } from "@/utils";
import { copyTerminalSelection } from "../terminalClipboard";
import {
  buildResumeCommand,
  buildSessionDeepLink,
  buildSessionInfoJson,
  isShareableResumeId,
  readWholeTranscript,
  transcriptToMarkdown,
  type TerminalSessionShareInfo,
} from "./terminalSessionShare";

export interface TerminalSessionMenuState {
  canFork: boolean;
  hasResumeCommand: boolean;
  hasWorkingDir: boolean;
  hasTranscript: boolean;
  hasDeepLink: boolean;
}

export interface TerminalSessionMenu {
  tabId: string;
  leafId?: string;
  getState: () => TerminalSessionMenuState;
  onCopyResumeCommand: () => void;
  onCopyWorkingDir: () => void;
  onCopySessionInfo: () => void;
  onCopyMarkdown: () => void;
  onCopyTranscriptPath: () => void;
  onCopyDeepLink: () => void;
  onExportTranscript: () => void;
}

/** 从 store 现取：resumeId 可能在会话运行中才捕获到，不能用渲染时的 props。 */
function readShareInfo(
  tabId: string,
  leafId: string | undefined,
  ptySessionId: string | null,
): TerminalSessionShareInfo | null {
  const tab = usePanesStore.getState().findTabAcrossLayouts(tabId)?.tab;
  if (!tab) return null;
  const leaf = tab.terminalRootPane
    ? collectTerminalLeaves(tab.terminalRootPane).find((item) => item.id === leafId)
    : undefined;
  const source = leaf ? { ...tab, ...leaf } : tab;
  return {
    cliTool: source.cliTool ?? (source.launchClaude ? "claude" : undefined),
    resumeId: source.resumeId,
    ptySessionId,
    cwd: source.launchExtras?.launchCwd ?? source.workspacePath ?? tab.projectPath,
    projectPath: tab.projectPath,
    workspaceName: source.workspaceName,
    providerId: source.providerId,
    modelId: source.modelId,
    launchProfileId: source.launchProfileId,
    runtime: source.ssh ? "ssh" : source.wsl ? "wsl" : "local",
  };
}

const TRANSCRIPT_CLIS = new Set(["claude", "codex", "grok"]);

/** 记录文件在本机才读得到：WSL/SSH 会话的 JSONL 不在这台机器的已知目录里。 */
function transcriptTarget(info: TerminalSessionShareInfo | null) {
  if (
    !info ||
    info.runtime !== "local" ||
    !info.cliTool ||
    !TRANSCRIPT_CLIS.has(info.cliTool) ||
    !isShareableResumeId(info.resumeId)
  ) {
    return null;
  }
  return { cliTool: info.cliTool, resumeSessionId: info.resumeId, cwd: info.cwd };
}

export function useTerminalSessionMenu({
  tabId,
  leafId,
  sessionId,
}: {
  tabId?: string;
  leafId?: string;
  sessionId: string | null;
}): TerminalSessionMenu | undefined {
  const { t } = useTranslation("panes");

  return useMemo(() => {
    if (!tabId) return undefined;
    const info = () => readShareInfo(tabId, leafId, sessionId);
    const copy = (text: string | null | undefined, success = t("terminalCopied")) => {
      if (!text) return;
      void copyTerminalSelection(text)
        .then(() => toast.success(success))
        .catch((error) => {
          toast.error(t("terminalCopyFailed", { error: getErrorMessage(error) }));
        });
    };
    const fail = (error: unknown) =>
      toast.error(t("terminalTranscriptFailed", { error: getErrorMessage(error) }));

    return {
      tabId,
      leafId,
      getState: () => {
        const current = info();
        const tab = usePanesStore.getState().findTabAcrossLayouts(tabId)?.tab;
        const fork = tab ? terminalForkSource(tab, leafId) : null;
        return {
          canFork: Boolean(fork && !fork.ssh),
          hasResumeCommand: Boolean(current && buildResumeCommand(current)),
          hasWorkingDir: Boolean(current?.cwd),
          hasTranscript: Boolean(isTauriRuntime() && transcriptTarget(current)),
          hasDeepLink: Boolean(current && buildSessionDeepLink(current)),
        };
      },
      onCopyResumeCommand: () => {
        const current = info();
        if (current) copy(buildResumeCommand(current), t("terminalCopyResumeHint"));
      },
      onCopyWorkingDir: () => copy(info()?.cwd),
      onCopySessionInfo: () => {
        const current = info();
        if (current) copy(buildSessionInfoJson(current));
      },
      onCopyDeepLink: () => {
        const current = info();
        if (current) copy(buildSessionDeepLink(current));
      },
      onCopyMarkdown: () => {
        const target = transcriptTarget(info());
        if (!target) return;
        void readWholeTranscript(agentTranscriptService.read, target)
          .then((messages) => {
            const markdown = transcriptToMarkdown(messages);
            if (markdown) copy(markdown);
            else toast.info(t("terminalMarkdownEmpty"));
          })
          .catch(fail);
      },
      onCopyTranscriptPath: () => {
        const target = transcriptTarget(info());
        if (!target) return;
        void agentTranscriptService
          .read({ ...target, limit: 1 })
          .then((result) => {
            if (result.errorCode) throw new Error(result.errorMessage ?? result.errorCode);
            copy(result.filePath);
          })
          .catch(fail);
      },
      onExportTranscript: () => {
        const target = transcriptTarget(info());
        if (!target) return;
        void (async () => {
          const destination = await saveFileDialog({
            defaultPath: `${target.cliTool}-${target.resumeSessionId}.jsonl`,
            filters: [{ name: "JSONL", extensions: ["jsonl"] }],
          });
          if (!destination) return;
          await agentTranscriptService.exportRaw({ ...target, destination });
          toast.success(t("terminalExportTranscriptSuccess", { path: destination }));
        })().catch(fail);
      },
    };
  }, [leafId, sessionId, t, tabId]);
}
