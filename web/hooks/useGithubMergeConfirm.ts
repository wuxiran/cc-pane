/**
 * gh_pr_merge 的用户确认：后端发 orchestrator-confirm-gh-merge，这里弹系统确认框，
 * 把 {approved} 回给 respond_orchestrator_query。合并不可逆，取消 / 出错一律回 false。
 */
import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import i18n from "@/i18n";
import { githubService } from "@/services/githubService";
import { nativeConfirm } from "@/services/nativeDialog";
import { isTauriRuntime, listenWebviewIfTauri } from "@/services/runtime";
import { handleErrorSilent } from "@/utils/errorHandler";

export interface GhMergeConfirmPayload {
  requestId: string;
  projectPath: string;
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  method: "merge" | "squash" | "rebase";
}

export const GH_MERGE_CONFIRM_EVENT = "orchestrator-confirm-gh-merge";

export function mergeConfirmMessage(payload: GhMergeConfirmPayload): string {
  return i18n.t("githubMergeConfirmDesc", {
    ns: "dialogs",
    number: payload.number,
    title: payload.title,
    head: payload.headRefName,
    base: payload.baseRefName,
    method: payload.method,
    url: payload.url,
  });
}

export async function handleMergeConfirm(payload: GhMergeConfirmPayload): Promise<void> {
  let approved = false;
  try {
    approved = await nativeConfirm(mergeConfirmMessage(payload), {
      title: i18n.t("githubMergeConfirmTitle", { ns: "dialogs" }),
      okLabel: i18n.t("githubMergeConfirmAction", { ns: "dialogs" }),
      cancelLabel: i18n.t("cancel", { ns: "common" }),
      kind: "warning",
    });
  } catch (error) {
    handleErrorSilent(error, "github merge confirm");
  }
  await githubService
    .respondMergeConfirm(payload.requestId, approved)
    .catch((error: unknown) => handleErrorSilent(error, "respond github merge confirm"));
}

export function useGithubMergeConfirm() {
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listenWebviewIfTauri<GhMergeConfirmPayload>(GH_MERGE_CONFIRM_EVENT, (event) => {
      if (event.payload?.requestId) void handleMergeConfirm(event.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error: unknown) => handleErrorSilent(error, "listen github merge confirm"));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
