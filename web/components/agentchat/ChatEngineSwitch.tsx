// 会话控制区的「切换引擎」入口：同一对话内换到另一个引擎继续（上下文交接）。
// 生成中、有待处理权限/提问、启动/提交未完成时禁用；列表只含可用且非当前的引擎。
import { useCallback, useState } from "react";
import { ArrowLeftRight, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { codexEngineLabel } from "@/lib/codexIntegration";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatRemoteStore } from "@/stores/useAgentChatRemoteStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpEngineInfo } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";
import ChatEngineIcon from "./ChatEngineIcon";
import { canSwitchEngine, handoffTargets, switchChatEngine } from "./chatEngineHandoff";

export default function ChatEngineSwitch({ chatId, cwd }: { chatId: string; cwd: string }) {
  const { t } = useTranslation("panes");
  const engineId = useAgentChatStore((state) => state.chats[chatId]?.snapshot?.engineId);
  const enabled = useAgentChatStore((state) => canSwitchEngine(state.chats[chatId]));
  const remote = useAgentChatRemoteStore((state) => Boolean(state.targets[chatId]));
  const [engines, setEngines] = useState<AcpEngineInfo[] | null>(null);

  const loadEngines = useCallback((open: boolean) => {
    if (!open) return;
    agentChatService.listEngines()
      .then(setEngines)
      .catch((error) => {
        handleErrorSilent(error, "list acp engines for handoff");
        setEngines([]);
      });
  }, []);

  const currentLabel = engines?.find((engine) => engine.id === engineId)?.label || codexEngineLabel(engineId ?? "");
  const targets = engines ? handoffTargets(engines, engineId, remote) : null;
  const pick = (target: AcpEngineInfo) => {
    void switchChatEngine({ chatId, target, currentEngineLabel: currentLabel, cwd })
      .catch((error) => handleErrorSilent(error, "switch acp chat engine"));
  };

  if (!engineId) return null;
  return (
    <DropdownMenu onOpenChange={loadEngines}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={!enabled || !cwd}
          aria-label={t("agentChatHandoffSwitch")}
          title={enabled ? t("agentChatHandoffSwitchHint") : t("agentChatHandoffDisabled")}
          data-testid="chat-engine-switch"
          className="flex h-7 min-w-0 items-center gap-1 rounded-md border border-transparent px-2 text-xs text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)] disabled:pointer-events-none disabled:opacity-50"
        >
          <ArrowLeftRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <ChatEngineIcon engineId={engineId} className="h-3.5 w-3.5" />
          <span className="max-w-32 truncate">{currentLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs font-normal text-[var(--app-text-tertiary)]">
          {t("agentChatHandoffSwitchHint")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {targets === null ? (
          <DropdownMenuItem disabled>{t("agentChatHandoffLoading")}</DropdownMenuItem>
        ) : targets.length === 0 ? (
          <DropdownMenuItem disabled>{t("agentChatHandoffNoEngines")}</DropdownMenuItem>
        ) : targets.map((engine) => (
          <DropdownMenuItem key={engine.id} title={engine.requirement || undefined} onSelect={() => pick(engine)}>
            <ChatEngineIcon engineId={engine.id} className="h-3.5 w-3.5" />
            <span className="flex-1 truncate">{engine.label || codexEngineLabel(engine.id)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
