// 参数 chips：YOLO（两态：未勾 = undefined 跟随 profile）/ effort 六档（default + 5）/
// 禁 MCP / 详细日志 / 最大轮数 / 追加系统提示 / 初始 prompt。
// 全部 per-launch 真实生效（Rust CreateSessionRequest 已支持），不置灰。
import { useTranslation } from "react-i18next";
import { EFFORT_LEVELS } from "@/constants/effortMapping";
import type { LaunchEffort } from "@/types";
import type { LauncherDraft } from "./launcherModel";

interface LauncherChipsProps {
  draft: LauncherDraft;
  onChange: (patch: Partial<LauncherDraft>) => void;
}

function ToggleChip({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      title={title}
      className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
      style={
        active
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <ToggleChip
          active={draft.yolo === true}
          label="YOLO"
          title={t("yoloHint")}
          onClick={() => onChange({ yolo: draft.yolo ? undefined : true })}
        />
        <ToggleChip
          active={draft.skipMcp}
          label={t("skipMcp")}
          onClick={() => onChange({ skipMcp: !draft.skipMcp })}
        />
        <ToggleChip
          active={draft.verbose}
          label={t("verbose")}
          onClick={() => onChange({ verbose: !draft.verbose })}
        />
        <label
          className="flex items-center gap-1.5 text-[11px]"
          style={{ color: "var(--app-text-secondary)" }}
        >
          {t("effort")}
          <select
            className="h-7 rounded-md border bg-background px-1.5 text-[11px]"
            value={draft.effort ?? ""}
            title={t("effortHint")}
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
          style={{ color: "var(--app-text-secondary)" }}
        >
          {t("maxTurns")}
          <input
            type="number"
            min={1}
            className="h-7 w-16 rounded-md border bg-background px-1.5 text-[11px]"
            value={draft.maxTurns ?? ""}
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
