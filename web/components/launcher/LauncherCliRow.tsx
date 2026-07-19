// CLI 选择：claude / codex / 仅终端 三个大按钮 + 「更多」下拉列出其余已注册工具。
// 未安装的工具标灰禁用（安装状态来自 useCliTools → Rust cc-cli-adapters 探测）。
import { Bot, ChevronDown, Sparkles, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCliTools } from "@/hooks/useCliTools";
import type { CliTool } from "@/types";

const PRIMARY_TOOLS = ["claude", "codex", "none"] as const;

function CliIcon({ cliTool, className }: { cliTool: CliTool; className?: string }) {
  if (cliTool === "codex") return <Bot className={className} />;
  if (cliTool === "none") return <Terminal className={className} />;
  return <Sparkles className={className} />;
}

interface LauncherCliRowProps {
  value: CliTool;
  onChange: (cliTool: CliTool) => void;
}

export default function LauncherCliRow({ value, onChange }: LauncherCliRowProps) {
  const { t } = useTranslation("launcher");
  const { tools } = useCliTools();

  function isInstalled(cliTool: CliTool): boolean {
    if (cliTool === "none") return true;
    const info = tools.find((tool) => tool.id === cliTool);
    // 工具列表未加载/未注册时不拦（后端启动时兜底报错）
    return info ? info.installed : true;
  }

  const moreTools = tools.filter(
    (tool) => tool.id !== "claude" && tool.id !== "codex",
  );
  const moreSelected = !PRIMARY_TOOLS.includes(value as (typeof PRIMARY_TOOLS)[number]);

  const primary: Array<{ cliTool: CliTool; label: string }> = [
    { cliTool: "claude", label: "Claude Code" },
    { cliTool: "codex", label: "Codex" },
    { cliTool: "none", label: t("terminalOnly") },
  ];

  return (
    <div className="flex items-center gap-2">
      {primary.map((item) => {
        const installed = isInstalled(item.cliTool);
        const active = value === item.cliTool;
        return (
          <button
            key={item.cliTool}
            type="button"
            disabled={!installed}
            className="flex flex-1 flex-col items-center gap-1.5 rounded-xl border px-3 py-3 transition-colors duration-[var(--dur-fast)] enabled:hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            style={
              active
                ? {
                    borderColor: "var(--app-accent)",
                    background: "color-mix(in srgb, var(--app-accent) 10%, transparent)",
                  }
                : { borderColor: "var(--app-border)", background: "var(--app-hover)" }
            }
            onClick={() => onChange(item.cliTool)}
            title={installed ? undefined : t("notInstalled")}
          >
            <CliIcon
              cliTool={item.cliTool}
              className="h-[18px] w-[18px]"
            />
            <span
              className="text-[12px] font-semibold"
              style={{ color: active ? "var(--app-accent)" : "var(--app-text-primary)" }}
            >
              {item.label}
            </span>
            {!installed && (
              <span className="text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
                {t("notInstalled")}
              </span>
            )}
          </button>
        );
      })}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-full flex-col items-center justify-center gap-1 rounded-xl border px-2.5 py-3 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
            style={
              moreSelected
                ? {
                    borderColor: "var(--app-accent)",
                    background: "color-mix(in srgb, var(--app-accent) 10%, transparent)",
                    color: "var(--app-accent)",
                  }
                : { borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }
            }
            aria-label={t("moreTools")}
          >
            <ChevronDown className="h-4 w-4" />
            <span className="text-[10.5px] font-medium">
              {moreSelected ? value : t("moreTools")}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          {moreTools.length === 0 && (
            <DropdownMenuItem disabled className="text-[12px]">
              {t("noMoreTools")}
            </DropdownMenuItem>
          )}
          {moreTools.map((tool) => (
            <DropdownMenuItem
              key={tool.id}
              disabled={!tool.installed}
              className="flex items-center gap-2 text-[12.5px]"
              onSelect={() => onChange(tool.id)}
            >
              <span className="flex-1">{tool.displayName}</span>
              {!tool.installed && (
                <span className="text-[10.5px]" style={{ color: "var(--app-text-tertiary)" }}>
                  {t("notInstalled")}
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
