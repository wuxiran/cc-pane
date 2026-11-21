// CLI 选择：一排小标签（品牌图标 + 名称），已装的全部平铺，不再藏进「更多」。
// Claude Code / Codex 始终在场：检测未完成或失败时不拦（后端启动时兜底报错），
// 确认未安装才置灰；其余 CLI 只在已安装时出现。「仅终端」恒在最后。
// 右侧 YOLO 开关只在当前 CLI 支持时出现（能力位口径见 resolveYoloSupport）。
import { Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import CliBrandIcon from "@/components/CliBrandIcon";
import { Switch } from "@/components/ui/switch";
import { useCliTools } from "@/hooks/useCliTools";
import type { CliTool, CliToolInfo } from "@/types";
import { cn } from "@/lib/utils";
import { resolveYoloSupport } from "./launcherCapabilities";

const ALWAYS_SHOWN: Array<{ id: CliTool; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

interface LauncherCliRowProps {
  value: CliTool;
  onChange: (cliTool: CliTool) => void;
  yolo?: boolean;
  onYoloChange?: (yolo: boolean) => void;
}

interface ChipItem {
  id: CliTool;
  label: string;
  disabled: boolean;
}

export function launcherCliChips(tools: readonly CliToolInfo[], value: CliTool): ChipItem[] {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const fixed = ALWAYS_SHOWN.map(({ id, label }) => ({
    id,
    label,
    // 工具列表未加载 / 未注册时不拦
    disabled: byId.get(id)?.installed === false,
  }));
  const others = tools
    .filter((tool) => !ALWAYS_SHOWN.some((item) => item.id === tool.id))
    .filter((tool) => tool.installed || tool.id === value)
    .map((tool) => ({ id: tool.id, label: tool.displayName, disabled: !tool.installed }));
  return [...fixed, ...others];
}

export default function LauncherCliRow({ value, onChange, yolo, onYoloChange }: LauncherCliRowProps) {
  const { t } = useTranslation("launcher");
  const { tools } = useCliTools();
  const chips = launcherCliChips(tools, value);
  const yoloSupport = onYoloChange ? resolveYoloSupport(value, tools) : "none";
  const cliName = chips.find((chip) => chip.id === value)?.label ?? value;

  const chipClass = (active: boolean) =>
    cn(
      "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[length:var(--text-small)] font-medium transition-colors duration-[var(--dur-fast)] enabled:hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-40",
      active
        ? "border-[var(--app-accent)] bg-[color-mix(in_srgb,var(--app-accent)_12%,transparent)] text-[var(--app-accent)]"
        : "border-[var(--app-border)] text-[var(--app-text-primary)]",
    );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="radiogroup" aria-label={t("sectionCli")}>
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="radio"
            aria-checked={value === chip.id}
            aria-label={chip.label}
            disabled={chip.disabled}
            title={chip.disabled ? t("notInstalled") : undefined}
            className={chipClass(value === chip.id)}
            onClick={() => onChange(chip.id)}
          >
            <CliBrandIcon cliTool={chip.id} className="size-3.5" />
            {chip.label}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={value === "none"}
          aria-label={t("terminalOnly")}
          className={chipClass(value === "none")}
          onClick={() => onChange("none")}
        >
          <Terminal className="size-3.5" aria-hidden="true" />
          {t("terminalOnly")}
        </button>
      </div>
      {yoloSupport !== "none" && onYoloChange && (
        <label
          className="flex shrink-0 items-center gap-2 text-[length:var(--text-small)] text-[var(--app-text-secondary)]"
          title={yoloSupport === "inherent" ? t("yoloInherent", { cli: cliName }) : t("yoloHint")}
        >
          {/* 自带全自动的 CLI：常开且不可关，让「它本来就不问」可见 */}
          <Switch
            checked={yoloSupport === "inherent" || yolo === true}
            disabled={yoloSupport === "inherent"}
            onCheckedChange={onYoloChange}
            aria-label="YOLO"
          />
          YOLO
        </label>
      )}
    </div>
  );
}
