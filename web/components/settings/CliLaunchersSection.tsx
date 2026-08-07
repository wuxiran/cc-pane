import { useState } from "react";
import { toast } from "sonner";
import { Play, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import CliToolSelect from "@/components/CliToolSelect";
import { useCliTools } from "@/hooks/useCliTools";
import { settingsService } from "@/services";
import type { CliLauncherSettings } from "@/types";

interface CliLaunchersSectionProps {
  value: CliLauncherSettings;
  onChange: (value: CliLauncherSettings) => void;
}

export default function CliLaunchersSection({ value, onChange }: CliLaunchersSectionProps) {
  const { t } = useTranslation("settings");
  const { tools, loading } = useCliTools();
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
      toast.success(t("cliLauncherTestSuccess", { output }));
    } catch (error) {
      toast.error(t("cliLauncherTestFailed", { error }));
    } finally {
      setTestingId(null);
    }
  }

  const selectedCommand = selectedTool ? commandFor(selectedTool.id) : "";
  const selectedEffectiveCommand = selectedCommand.trim() || selectedTool?.executable || "";
  const selectedInputId = selectedTool ? `cli-launcher-command-${selectedTool.id}` : undefined;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-8 items-center justify-end">
        {tools.length > 0 ? (
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
        ) : loading ? (
          <span className="text-xs text-[var(--app-text-tertiary)]">
            {t("loading", { ns: "common" })}
          </span>
        ) : (
          <span className="text-xs text-[var(--app-text-tertiary)]">
            {t("cliLauncherEmpty")}
          </span>
        )}
      </div>

      {selectedTool && (
        <div
          data-testid="cli-launcher-editor"
          data-cli-tool={selectedTool.id}
          className="rounded-md p-4"
          style={{
            border: "1px solid var(--app-border)",
            background: "var(--app-content)",
          }}
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-[var(--app-text-primary)]">
                  {selectedTool.displayName}
                </span>
                <Badge variant={selectedTool.installed ? "secondary" : "outline"} className="rounded-md">
                  {selectedTool.installed ? t("cliInstalled") : t("cliNotInstalled")}
                </Badge>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-[var(--app-text-tertiary)]">
                {selectedTool.path || selectedTool.executable}
              </div>
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title={t("cliLauncherReset")}
              aria-label={t("cliLauncherReset")}
              disabled={!selectedCommand}
              onClick={() => updateCommand(selectedTool.id, "")}
            >
              <RotateCcw size={14} />
            </Button>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={selectedInputId}>{t("cliLauncherCommand")}</Label>
            <div className="flex gap-2 max-[640px]:flex-col">
              <Input
                id={selectedInputId}
                value={selectedCommand}
                onChange={(event) => updateCommand(selectedTool.id, event.target.value)}
                placeholder={selectedTool.executable}
                className="font-mono text-xs"
                title={selectedCommand || selectedTool.executable}
              />
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
            </div>
            <p className="m-0 text-[11px] text-[var(--app-text-tertiary)]">
              {selectedCommand.trim()
                ? t("cliLauncherOverrideActive", { command: selectedEffectiveCommand })
                : t("cliLauncherDefaultActive", { command: selectedTool.executable })}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
