import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface CliToolSelectOption {
  id: string;
  label: string;
  installed: boolean;
  count?: number;
}

interface CliToolSelectProps {
  value: string;
  options: CliToolSelectOption[];
  onValueChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

/** 导出供穷举守卫测试核对：这是开放 Record，漏条目只会静默掉色。 */
export const CLI_COLOR_VAR: Record<string, string> = {
  claude: "var(--app-cli-claude)",
  codex: "var(--app-cli-codex)",
  pi: "var(--app-cli-pi)",
  gemini: "var(--app-cli-gemini)",
  kimi: "var(--app-cli-kimi)",
  glm: "var(--app-cli-glm)",
  opencode: "var(--app-cli-opencode)",
  cursor: "var(--app-cli-cursor)",
  grok: "var(--app-cli-grok)",
};

export default function CliToolSelect({
  value,
  options,
  onValueChange,
  className,
  disabled,
}: CliToolSelectProps) {
  const { t } = useTranslation("settings");
  const activeOption = options.find((option) => option.id === value);
  const activeColor = CLI_COLOR_VAR[value] ?? "var(--app-accent)";

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-xs font-medium text-[var(--app-text-tertiary)]">CLI</span>
      <Select
        value={value || undefined}
        onValueChange={onValueChange}
        disabled={disabled || options.length === 0}
      >
        <SelectTrigger
          size="sm"
          className={cn("w-[192px] shrink-0 bg-[var(--app-panel-bg)]", className)}
          aria-label={t("cliToolSelect")}
        >
          {activeOption ? (
            <SelectValue>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: activeColor }}
                />
                <span className="min-w-0 flex-1 truncate">{activeOption.label}</span>
                {(activeOption.count ?? 0) > 0 && (
                  <span className="text-[10px] tabular-nums text-[var(--app-text-tertiary)]">
                    {activeOption.count}
                  </span>
                )}
              </span>
            </SelectValue>
          ) : (
            <SelectValue placeholder={t("cliToolSelect")} />
          )}
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => {
            const color = CLI_COLOR_VAR[option.id] ?? "var(--app-accent)";

            return (
              <SelectItem key={option.id} value={option.id}>
                <span className="flex min-w-[170px] items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: color }}
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {(option.count ?? 0) > 0 && (
                    <span className="text-[10px] tabular-nums text-[var(--app-text-tertiary)]">
                      {option.count}
                    </span>
                  )}
                  {!option.installed && (
                    <span className="text-[10px] text-[var(--app-text-tertiary)]">
                      {t("cliNotInstalled")}
                    </span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
