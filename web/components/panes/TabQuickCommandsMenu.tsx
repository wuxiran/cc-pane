// tab 右键菜单的「运行快捷命令」子菜单：从 TabBar 拆出（行数棘轮约束），语义不变。
// 无可见快捷命令时渲染 null，由调用方无条件挂载。
import { Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { filterQuickCommandsForProject, useQuickCommandsStore } from "@/stores";
import { executeQuickCommand, getQuickCommandSessionId } from "@/lib/quickCommandExecution";
import type { ScopedQuickCommand, Tab } from "@/types";

export default function TabQuickCommandsMenu({ tab, paneId }: { tab: Tab; paneId: string }) {
  const { t } = useTranslation("panes");
  const quickCommands = useQuickCommandsStore((state) => state.commands);
  const activeProjectPath = useQuickCommandsStore((state) => state.activeProjectPath);
  const visibleQuickCommands = filterQuickCommandsForProject(
    quickCommands,
    activeProjectPath,
    tab.projectPath,
  );

  const disabledReason = (command: ScopedQuickCommand): string | undefined => {
    if (command.target === "currentPane" && !getQuickCommandSessionId(tab)) {
      return t("quickCommandNoActiveTerminal");
    }
    if (command.target === "newTab" && !tab.projectPath) {
      return t("quickCommandNoActiveProject");
    }
    if (
      command.kind === "agentPrompt"
      && command.target === "newTab"
      && (!command.cliTool || command.cliTool === "none")
    ) {
      return t("quickCommandNoCliTool");
    }
    return undefined;
  };

  const run = (command: ScopedQuickCommand) => {
    if (disabledReason(command)) return;
    const { scope: _scope, ...quickCommand } = command;
    void executeQuickCommand(quickCommand, { paneId, tab }).catch((error) => {
      toast.error(t("quickCommandExecuteFailed", { error: String(error) }));
    });
  };

  if (visibleQuickCommands.length === 0) return null;

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Play /> {t("runQuickCommand")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-64">
        {visibleQuickCommands.map((command) => {
          const reason = disabledReason(command);
          return (
            <ContextMenuItem
              key={`${command.scope}-${command.id}`}
              disabled={Boolean(reason)}
              title={reason}
              onClick={() => run(command)}
            >
              <span className="min-w-0 flex-1 truncate">{command.name}</span>
              <span className="text-xs text-[var(--app-text-tertiary)]">
                {command.scope === "global" ? t("quickCommandGlobal") : t("quickCommandProject")}
              </span>
            </ContextMenuItem>
          );
        })}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
