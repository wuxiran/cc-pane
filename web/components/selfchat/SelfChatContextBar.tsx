import { useTranslation } from "react-i18next";
import { Bot, RotateCcw, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SelfChatSession } from "@/types";

interface SelfChatContextBarProps {
  session: SelfChatSession;
  onRestart: () => void;
  onEndSession: () => void;
}

export default function SelfChatContextBar({
  session,
  onRestart,
  onEndSession,
}: SelfChatContextBarProps) {
  const { t } = useTranslation("common");

  const statusBadge = (() => {
    if (session.systemPrompt !== null) {
      return (
        <Badge variant="outline" className="text-xs text-emerald-500 border-emerald-500/30">
          {t("selfChat.contextInjected")}
        </Badge>
      );
    }
    if (session.status === "initializing") {
      return (
        <Badge variant="outline" className="text-xs text-amber-500 border-amber-500/30 animate-pulse">
          {t("selfChat.injecting")}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-xs text-muted-foreground">
        {t("selfChat.notInjected")}
      </Badge>
    );
  })();

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 border-b shrink-0"
      style={{ borderColor: "var(--app-border)" }}
    >
      <Bot className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs font-medium">CC-Panes</span>
      {statusBadge}

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onRestart}
        >
          <RotateCcw className="w-3 h-3 mr-1" />
          {t("selfChat.restart")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-destructive"
          onClick={onEndSession}
        >
          <Square className="w-3 h-3 mr-1" />
          {t("selfChat.endSession")}
        </Button>
      </div>
    </div>
  );
}
