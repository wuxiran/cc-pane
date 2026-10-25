import "@/i18n/codexIntegrationResources";
import { Bot, ExternalLink, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { CODEX_APP_SERVER_ENGINE, codexHandoffWorkspace, codexOpenTarget, isLocalCodexPath } from "@/lib/codexIntegration";
import { codexDesktopService } from "@/services/codexDesktopService";
import { isTauriRuntime } from "@/services/runtime";
import { usePanesStore } from "@/stores/usePanesStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { handleError } from "@/utils/errorHandler";
import type { Tab } from "@/types";
import type { AcpChatSnapshot } from "@/types/agentChat";

export default function CodexMenuItems({ tab, snapshot, cwd, menuKind = "context", onHandoff }: {
  tab: Tab; snapshot?: AcpChatSnapshot | null; cwd?: string; menuKind?: "context" | "dropdown"; onHandoff?: (cwd: string) => void;
}) {
  const { t } = useTranslation("codexIntegration");
  const stored = useAgentChatStore((state) => state.chats[tab.id]);
  const target = codexOpenTarget(tab, snapshot ?? stored?.snapshot, cwd || stored?.cwdOverride || undefined);
  const handoffCwd = codexHandoffWorkspace(tab, cwd || stored?.cwdOverride || undefined);
  if (!isTauriRuntime() || (!target && !(handoffCwd && onHandoff))) return null;
  const Item = menuKind === "context" ? ContextMenuItem : DropdownMenuItem;
  const open = () => {
    if (!target) return;
    void codexDesktopService.open(target).catch((error) => handleError(error, "open in Codex"));
  };
  return <>
    {target && <Item onSelect={open} title={target.threadId ? t("openExistingHint") : t("openNewHint")}><ExternalLink />{t("open")}</Item>}
    {handoffCwd && onHandoff && <Item onSelect={() => onHandoff(handoffCwd)}><Send />{t("handoff")}</Item>}
    {target && tab.contentType === "terminal" && isLocalCodexPath(target.cwd) && <Item onSelect={() => {
      // Prepare a new native conversation; never attach a second writer to a live CLI thread.
      usePanesStore.getState().openAgentChat(target.cwd, { engineId: CODEX_APP_SERVER_ENGINE, parentTabId: tab.id });
    }} title={t("nativeHint")}><Bot />{t("native")}</Item>}
  </>;
}
