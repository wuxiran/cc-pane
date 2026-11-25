import { useState } from "react";
import { toastErr, toastOk } from "@/lib/feedback";
import { Play, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import CliToolSelect from "@/components/CliToolSelect";
import { useCliTools } from "@/hooks/useCliTools";
import { settingsService } from "@/services";
import type { CliLauncherSettings, CliToolInfo } from "@/types";
import { CLI_TOOL_TABS } from "@/types/provider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingsRow, SettingsSection, SettingsValue } from "./layout";

type LauncherTool = Omit<CliToolInfo, "installed"> & { installed?: boolean };
const FALLBACK_TOOL_LABELS: Record<string, string> = {
  claude: "Claude Code", codex: "Codex CLI", pi: "Pi", omp: "OMP", gemini: "Gemini CLI",
  kimi: "Kimi CLI", opencode: "OpenCode", cursor: "Cursor Agent", grok: "Grok CLI", jcode: "JCode",
  antigravity: "Antigravity", kiro: "Kiro CLI", fx: "fx", muse: "Muse Code",
};
/** CLI id 与可执行名不一致的条目（其余 id 即可执行名；与 cc-cli-adapters 各适配器的 executable 对齐）。 */
const FALLBACK_TOOL_EXECUTABLES: Record<string, string> = {
  cursor: "cursor-agent", antigravity: "agy", kiro: "kiro-cli",
};
// Editing a command needs static metadata, not successful host detection.
// Keep this fallback local: an unknown install state must never gate launching.
const FALLBACK_LAUNCHER_TOOLS: LauncherTool[] = CLI_TOOL_TABS.map(({ id }) => ({
  id, displayName: FALLBACK_TOOL_LABELS[id] ?? id,
  executable: FALLBACK_TOOL_EXECUTABLES[id] ?? id,
  versionArgs: ["--version"], version: null, path: null,
}));

interface CliLaunchersSectionProps {
  value: CliLauncherSettings;
  onChange: (value: CliLauncherSettings) => void;
}

export default function CliLaunchersSection({ value, onChange }: CliLaunchersSectionProps) {
  const { t } = useTranslation(["settings", "common"]);
  const { tools: detectedTools, loading } = useCliTools();
  const tools: LauncherTool[] = detectedTools.length > 0 ? detectedTools : FALLBACK_LAUNCHER_TOOLS;
  const [selectedToolId, setSelectedToolId] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const selectedTool = tools.find((tool) => tool.id === selectedToolId) ?? tools[0];
  const effectiveSelectedToolId = selectedTool?.id ?? "";

  function commandFor(toolId: string): string {
    return value.overrides[toolId]?.command ?? "";
  }

  function updateCommand(toolId: string, command: string) {
    const overrides = { ...value.overrides };
    if (command.trim()) {
      overrides[toolId] = { command };
    } else {
      delete overrides[toolId];
    }
    onChange({ ...value, overrides });
  }

  async function testCommand(toolId: string, command: string, versionArgs: string[]) {
    setTestingId(toolId);
    try {
      const output = await settingsService.testCliLauncher(command, versionArgs);
      toastOk(t("cliLauncherTestSuccess", { output }));
    } catch (error) {
      toastErr(t("cliLauncherTestFailed", { error }));
    } finally {
      setTestingId(null);
    }
  }

  const selectedCommand = selectedTool ? commandFor(selectedTool.id) : "";
  const selectedEffectiveCommand = selectedCommand.trim() || selectedTool?.executable || "";
  const selectedInputId = selectedTool ? `cli-launcher-command-${selectedTool.id}` : undefined;

  return (
    <SettingsSection
      title={t("cliLaunchersTitle")}
      description={t("cliLaunchersDesc")}
      data-testid="cli-launcher-editor"
      data-cli-tool={selectedTool?.id}
    >
      <SettingsRow
        title={selectedTool ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{selectedTool.displayName}</span>
            <Badge variant={selectedTool.installed ? "secondary" : "outline"} className="rounded-md">
              {selectedTool.installed === undefined
                ? loading ? t("checking") : t("common:contextUsage.windowSources.unknown")
                : selectedTool.installed ? t("cliInstalled") : t("cliNotInstalled")}
            </Badge>
          </span>
        ) : t("cliToolSelect")}
        control={(
          <CliToolSelect
            value={effectiveSelectedToolId}
            options={tools.map((tool) => ({
              id: tool.id,
              label: tool.displayName,
              installed: tool.installed,
            }))}
            onValueChange={setSelectedToolId}
            className="w-[220px]"
          />
        )}
      >
        {selectedTool && (
          <SettingsValue title={selectedTool.path || selectedTool.executable}>
            {selectedTool.path || selectedTool.executable}
          </SettingsValue>
        )}
      </SettingsRow>

      {selectedTool && (
        <SettingsRow
          title={t("cliLauncherCommand")}
          htmlFor={selectedInputId}
          description={selectedCommand.trim()
            ? t("cliLauncherOverrideActive", { command: selectedEffectiveCommand })
            : t("cliLauncherDefaultActive", { command: selectedTool.executable })}
          control={(
            <>
              <Tooltip><TooltipTrigger asChild><Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("cliLauncherReset")}
                disabled={!selectedCommand}
                onClick={() => updateCommand(selectedTool.id, "")}
              >
                <RotateCcw size={14} />
              </Button></TooltipTrigger><TooltipContent>{t("cliLauncherReset")}</TooltipContent></Tooltip>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={testingId === selectedTool.id}
                onClick={() => testCommand(
                  selectedTool.id,
                  selectedEffectiveCommand,
                  selectedTool.versionArgs?.length ? selectedTool.versionArgs : ["--version"],
                )}
              >
                <Play size={14} />
                {testingId === selectedTool.id ? t("testing") : t("cliLauncherTest")}
              </Button>
            </>
          )}
        >
          <Input
            id={selectedInputId}
            value={selectedCommand}
            onChange={(event) => updateCommand(selectedTool.id, event.target.value)}
            placeholder={selectedTool.executable}
            className="h-8 font-mono text-xs"
            title={selectedCommand || selectedTool.executable}
          />
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
