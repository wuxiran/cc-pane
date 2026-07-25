// 命令面板（Ctrl+K）：聚合已注册快捷键动作 / 工作空间跳转 / 布局切换。
// 打开入口走 shortcuts 体系（action id: command-palette），终端聚焦时放行给终端。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Zap, FolderOpen, LayoutGrid, Play } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  useShortcutsStore,
  useSettingsStore,
  useWorkspacesStore,
  usePanesStore,
  useActivityBarStore,
  filterQuickCommandsForProject,
  useQuickCommandsStore,
} from "@/stores";
import { formatKeyCombo } from "@/stores/useShortcutsStore";
import { isTauriRuntime } from "@/services/runtime";
import { getVisibleSettingsPanes } from "@/components/settings/settingsRegistry";
import { navigateToSettings } from "@/components/settings/settingsNavigation";
import { getSettingsCommandTargets } from "@/components/settings/settingsSearch";
import { MODULE_CONSUMERS } from "@/modules/registry";
import { findPane } from "@/stores/paneTreeHelpers";
import {
  executeQuickCommand,
  getQuickCommandSessionId,
} from "@/lib/quickCommandExecution";
import type { ScopedQuickCommand } from "@/types";

export const COMMAND_PALETTE_TOGGLE_EVENT = "cc-panes:command-palette-toggle";

export default function CommandPalette() {
  const { t } = useTranslation(["shortcuts", "sidebar", "common", "settings"]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const toggle = () => setOpen((prev) => !prev);
    window.addEventListener(COMMAND_PALETTE_TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(COMMAND_PALETTE_TOGGLE_EVENT, toggle);
  }, []);

  const actions = useShortcutsStore((s) => s.actions);
  const bindings = useSettingsStore((s) => s.settings?.shortcuts.bindings);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const rootPane = usePanesStore((s) => s.rootPane);
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const quickCommands = useQuickCommandsStore((s) => s.commands);
  const quickCommandsProjectPath = useQuickCommandsStore((s) => s.activeProjectPath);
  const activeContext = useMemo(() => {
    const pane = findPane(rootPane, activePaneId);
    if (pane?.type !== "panel") return null;
    const tab = pane.tabs.find((item) => item.id === pane.activeTabId);
    return tab ? { paneId: pane.id, tab } : null;
  }, [activePaneId, rootPane]);
  const settingsPanes = getVisibleSettingsPanes({
    isMac: navigator.platform.toUpperCase().includes("MAC"),
    isTauri: isTauriRuntime(),
  });
  const visibleQuickCommands = useMemo(
    () => filterQuickCommandsForProject(
      quickCommands,
      quickCommandsProjectPath,
      activeContext?.tab.projectPath,
    ),
    [activeContext?.tab.projectPath, quickCommands, quickCommandsProjectPath],
  );

  const runAndClose = useCallback((fn: () => void) => {
    setOpen(false);
    // 先关面板再执行，避免焦点被 Dialog 卸载抢回
    requestAnimationFrame(fn);
  }, []);

  const jumpToWorkspace = useCallback((workspaceId: string) => {
    runAndClose(() => {
      const activity = useActivityBarStore.getState();
      if (activity.appViewMode !== "panes" && activity.appViewMode !== "files") {
        activity.setAppViewMode("panes");
      }
      useActivityBarStore.setState({ activeView: "explorer", sidebarVisible: true });
      useWorkspacesStore.getState().expandWorkspace(workspaceId);
    });
  }, [runAndClose]);

  const quickCommandDisabledReason = useCallback((command: ScopedQuickCommand) => {
    if (!activeContext) return t("quickCommands.noActiveTab", { ns: "settings" });
    if (command.target === "currentPane" && !getQuickCommandSessionId(activeContext.tab)) {
      return t("quickCommands.noActiveTerminal", { ns: "settings" });
    }
    if (command.target === "newTab" && !activeContext.tab.projectPath) {
      return t("quickCommands.noActiveProject", { ns: "settings" });
    }
    if (
      command.kind === "agentPrompt"
      && command.target === "newTab"
      && (!command.cliTool || command.cliTool === "none")
    ) {
      return t("quickCommands.noCliTool", { ns: "settings" });
    }
    return undefined;
  }, [activeContext, t]);

  const runQuickCommand = useCallback((command: ScopedQuickCommand) => {
    if (!activeContext || quickCommandDisabledReason(command)) return;
    const { scope: _scope, ...quickCommand } = command;
    runAndClose(() => {
      void executeQuickCommand(quickCommand, activeContext).catch((error) => {
        toast.error(t("quickCommands.executeFailed", {
          ns: "settings",
          error: String(error),
        }));
      });
    });
  }, [activeContext, quickCommandDisabledReason, runAndClose, t]);

  // 面板打开的动作本身（command-palette）不列入清单
  const listedActions = Array.from(actions.values()).filter(
    (action) => action.id !== "command-palette" && !/^switch-(tab|layout)-\d+$/.test(action.id),
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title={t("command-palette", { ns: "shortcuts", defaultValue: "命令面板" })}>
      <CommandInput
        placeholder={t("commandPalettePlaceholder", {
          ns: "shortcuts",
          defaultValue: "输入命令、工作空间或布局名…",
        })}
      />
      <CommandList>
        <CommandEmpty>
          {t("commandPaletteEmpty", { ns: "shortcuts", defaultValue: "没有匹配的命令" })}
        </CommandEmpty>

        <CommandGroup heading={t("commandGroupActions", { ns: "shortcuts", defaultValue: "命令" })}>
          {listedActions.map((action) => (
            <CommandItem
              key={action.id}
              value={`${action.label} ${action.id}`}
              onSelect={() => runAndClose(action.handler)}
            >
              <Zap strokeWidth={1.5} />
              <span className="truncate">{action.label}</span>
              {bindings?.[action.id] && (
                <CommandShortcut>{formatKeyCombo(bindings[action.id])}</CommandShortcut>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading={t("modules.commandGroup", { ns: "settings" })}>
          {MODULE_CONSUMERS.commandPalette.map((module) => {
            const Icon = module.icon;
            const moduleName = t(module.titleKey as never, { ns: "sidebar" });
            const actionLabel = t("modules.openAction", {
              ns: "settings",
              module: moduleName,
            });
            return (
              <CommandItem
                key={module.id}
                data-testid={`module-command-${module.id}`}
                value={`${actionLabel} ${module.id}`}
                onSelect={() => runAndClose(() => module.open("hidden"))}
              >
                <Icon strokeWidth={1.5} />
                <span className="truncate">{actionLabel}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        {visibleQuickCommands.length > 0 && (
          <CommandGroup heading={t("quickCommands.commandGroup", { ns: "settings" })}>
            {visibleQuickCommands.map((command) => {
              const disabledReason = quickCommandDisabledReason(command);
              return (
                <CommandItem
                  key={`${command.scope}-${command.id}`}
                  value={`${command.name} ${command.text} ${t(`quickCommands.scope.${command.scope}`, { ns: "settings" })}`}
                  disabled={Boolean(disabledReason)}
                  title={disabledReason}
                  onSelect={() => runQuickCommand(command)}
                >
                  <Play strokeWidth={1.5} />
                  <span className="min-w-0 flex-1 truncate">{command.name}</span>
                  <span className="truncate text-[11px] text-[var(--app-text-tertiary)]">
                    {t(`quickCommands.scope.${command.scope}`, { ns: "settings" })}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        <CommandGroup heading={t("searchCommandGroup", { ns: "settings" })}>
          {getSettingsCommandTargets(settingsPanes).map(({ pane, entry }) => {
            const Icon = pane.icon;
            const paneTitle = t(pane.titleKey as never, { ns: "settings" });
            const title = t(entry.titleKey as never, { ns: "settings" });
            const description = entry.descriptionKey
              ? t(entry.descriptionKey as never, { ns: "settings" })
              : "";
            const keywords = entry.keywordsKey
              ? t(entry.keywordsKey as never, { ns: "settings" })
              : "";
            return (
              <CommandItem
                key={`settings-${pane.id}-${entry.id}`}
                value={`settings ${paneTitle} ${title} ${description} ${keywords}`}
                onSelect={() => runAndClose(() => navigateToSettings({
                  paneId: pane.id,
                  targetSectionId: entry.targetSectionId,
                }))}
              >
                <Icon strokeWidth={1.5} />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span className="truncate text-[11px] text-[var(--app-text-tertiary)]">{paneTitle}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        {workspaces.length > 0 && (
          <CommandGroup heading={t("commandGroupWorkspaces", { ns: "shortcuts", defaultValue: "工作空间" })}>
            {workspaces.filter((ws) => !ws.hidden).map((ws) => (
              <CommandItem
                key={ws.id}
                value={`workspace ${ws.alias || ws.name}`}
                onSelect={() => jumpToWorkspace(ws.id)}
              >
                <FolderOpen strokeWidth={1.5} />
                <span className="truncate">{ws.alias || ws.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {layouts.length > 1 && (
          <CommandGroup heading={t("commandGroupLayouts", { ns: "shortcuts", defaultValue: "布局" })}>
            {layouts.map((layout, index) => (
              <CommandItem
                key={layout.id}
                value={`layout ${layout.name ?? index + 1}`}
                disabled={layout.id === currentLayoutId}
                onSelect={() => runAndClose(() => usePanesStore.getState().switchLayout(layout.id))}
              >
                <LayoutGrid strokeWidth={1.5} />
                <span className="truncate">
                  {layout.name || `${t("layout", { ns: "common", defaultValue: "布局" })} ${index + 1}`}
                </span>
                {index < 9 && <CommandShortcut>{formatKeyCombo(`Alt+${index + 1}`)}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
