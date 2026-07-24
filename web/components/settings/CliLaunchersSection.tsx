import { useState } from "react";
import { toast } from "sonner";
import { Play, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  const [testingId, setTestingId] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {loading && (
          <div className="text-xs py-3" style={{ color: "var(--app-text-tertiary)" }}>
            {t("loading", { ns: "common" })}
          </div>
        )}

        {tools.map((tool) => {
          const command = commandFor(tool.id);
          const effectiveCommand = command.trim() || tool.executable;
          return (
            <div
              key={tool.id}
              className="rounded-md p-3"
              style={{
                border: "1px solid var(--app-border)",
                background: "var(--app-content)",
              }}
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate" style={{ color: "var(--app-text-primary)" }}>
                      {tool.displayName}
                    </span>
                    <Badge variant={tool.installed ? "secondary" : "outline"} className="rounded-md">
                      {tool.installed ? t("cliInstalled") : t("cliNotInstalled")}
                    </Badge>
                  </div>
                  <div className="text-[11px] mt-1 font-mono truncate" style={{ color: "var(--app-text-tertiary)" }}>
                    {tool.path || tool.executable}
                  </div>
                </div>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  title={t("cliLauncherReset")}
                  disabled={!command}
                  onClick={() => updateCommand(tool.id, "")}
                >
                  <RotateCcw size={14} />
                </Button>
              </div>

              <div className="flex flex-col gap-1">
                <Label>{t("cliLauncherCommand")}</Label>
                <div className="flex gap-2">
                  <Input
                    value={command}
                    onChange={(event) => updateCommand(tool.id, event.target.value)}
                    placeholder={tool.executable}
                    className="font-mono text-xs"
                    title={command || tool.executable}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={testingId === tool.id}
                    onClick={() => testCommand(tool.id, effectiveCommand, tool.versionArgs?.length ? tool.versionArgs : ["--version"])}
                  >
                    <Play size={14} />
                    {testingId === tool.id ? t("testing") : t("cliLauncherTest")}
                  </Button>
                </div>
                <p className="text-[11px] m-0" style={{ color: "var(--app-text-tertiary)" }}>
                  {command.trim()
                    ? t("cliLauncherOverrideActive", { command: effectiveCommand })
                    : t("cliLauncherDefaultActive", { command: tool.executable })}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
