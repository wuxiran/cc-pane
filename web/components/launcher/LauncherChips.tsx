// 参数 chips：YOLO（两态：未勾 = undefined 跟随 profile）/ effort 六档（default + 5）/
// 禁 MCP / 详细日志 / 最大轮数 / 追加系统提示 / 初始 prompt。
//
// **effort / 详细日志 / 最大轮数按目标 CLI 的能力位置灰**：这三个键由 adapter 的
// build_command 各自消费，不支持的会被静默丢弃（实测 8 个 adapter 里 5 个三键全不消费）。
// 置灰而非隐藏，是为了让「这个 CLI 做不到」可见——隐藏会让用户以为功能不存在。
// YOLO / 禁 MCP / 系统提示 / 初始 prompt 是全 CLI 通用，不受门控。
import { useTranslation } from "react-i18next";
import { EFFORT_LEVELS } from "@/constants/effortMapping";
import { useCliTools } from "@/hooks/useCliTools";
import type { LaunchEffort } from "@/types";
import { resolveLaunchOptionSupport } from "./launcherCapabilities";
import type { LauncherDraft } from "./launcherModel";

interface LauncherChipsProps {
  draft: LauncherDraft;
  onChange: (patch: Partial<LauncherDraft>) => void;
}

function ToggleChip({
  active,
  label,
  title,
  disabled,
  onClick,
}: {
  active: boolean;
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      aria-disabled={disabled}
      disabled={disabled}
      title={title}
      className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      style={
        active && !disabled
          ? {
              borderColor: "var(--app-accent)",
              background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
              color: "var(--app-accent)",
            }
          : { borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export default function LauncherChips({ draft, onChange }: LauncherChipsProps) {
  const { t } = useTranslation("launcher");
  const piLaunch = draft.cliTool === "pi";
  const { tools } = useCliTools();
  const support = resolveLaunchOptionSupport(draft.cliTool, tools);
  const unsupportedHint = t("optionUnsupported", { cli: draft.cliTool });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {!piLaunch && (
          <ToggleChip
            active={draft.yolo === true}
            label="YOLO"
            title={t("yoloHint")}
            onClick={() => onChange({ yolo: draft.yolo ? undefined : true })}
          />
        )}
        {!piLaunch && (
          <ToggleChip
            active={draft.skipMcp}
            label={t("skipMcp")}
            onClick={() => onChange({ skipMcp: !draft.skipMcp })}
          />
        )}
        <ToggleChip
          active={draft.verbose}
          label={t("verbose")}
          disabled={!support.verbose}
          title={support.verbose ? undefined : unsupportedHint}
          onClick={() => onChange({ verbose: !draft.verbose })}
        />
        <label
          className="flex items-center gap-1.5 text-[11px]"
          style={{ color: "var(--app-text-secondary)", opacity: support.effort ? 1 : 0.4 }}
          title={support.effort ? undefined : unsupportedHint}
        >
          {t("effort")}
          <select
            className="h-7 rounded-md border bg-background px-1.5 text-[11px] disabled:cursor-not-allowed"
            value={draft.effort ?? ""}
            disabled={!support.effort}
            title={support.effort ? t("effortHint") : unsupportedHint}
            onChange={(event) =>
              onChange({ effort: (event.target.value || undefined) as LaunchEffort | undefined })
            }
          >
            <option value="">{t("effortDefault")}</option>
            {EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`effortLevel.${level}`)}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex items-center gap-1.5 text-[11px]"
          style={{ color: "var(--app-text-secondary)", opacity: support.maxTurns ? 1 : 0.4 }}
          title={support.maxTurns ? undefined : unsupportedHint}
        >
          {t("maxTurns")}
          <input
            type="number"
            min={1}
            className="h-7 w-16 rounded-md border bg-background px-1.5 text-[11px] disabled:cursor-not-allowed"
            value={draft.maxTurns ?? ""}
            disabled={!support.maxTurns}
            title={support.maxTurns ? undefined : unsupportedHint}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              onChange({ maxTurns: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined });
            }}
          />
        </label>
      </div>

      <textarea
        rows={2}
        className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-[11.5px]"
        placeholder={t("appendSystemPromptPlaceholder")}
        value={draft.appendSystemPrompt}
        onChange={(event) => onChange({ appendSystemPrompt: event.target.value })}
        aria-label={t("appendSystemPrompt")}
      />
      <textarea
        rows={2}
        className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-[11.5px]"
        placeholder={t("initialPromptPlaceholder")}
        value={draft.initialPrompt}
        onChange={(event) => onChange({ initialPrompt: event.target.value })}
        aria-label={t("initialPrompt")}
      />
    </div>
  );
}
