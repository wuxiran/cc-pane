// 技能卡：字母图标 + 名称 + 来源/安装量角标 + 两行描述 + 安装按钮。
// `featured` 变体更高、带 accent 描边，用于顶部精选横排。
import { Check, Download, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { isTauriRuntime } from "@/services/runtime";
import type { SkillMarketEntry } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import {
  formatInstalls,
  iconGlyph,
  needsDescription,
  repoLabel,
  sourceLabelKey,
  toneFor,
} from "./skillMarketModel";

// 沿用 UpdateNotification / openGuideDoc 的外链惯例：桌面走 opener，浏览器兜底 window.open
async function openExternal(url: string): Promise<void> {
  try {
    if (isTauriRuntime()) await openUrl(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (reason) {
    handleErrorSilent(reason, "open skill source");
  }
}

interface SkillMarketCardProps {
  entry: SkillMarketEntry;
  installed: boolean;
  busy: boolean;
  featured?: boolean;
  onInstall: (entry: SkillMarketEntry) => void;
  onRemove: (entry: SkillMarketEntry) => void;
}

export default function SkillMarketCard({
  entry,
  installed,
  busy,
  featured = false,
  onInstall,
  onRemove,
}: SkillMarketCardProps) {
  const { t } = useTranslation("skillMarket");
  const tone = toneFor(entry.name);
  const installs = formatInstalls(entry.installs);
  const repo = repoLabel(entry);
  const description = entry.description?.trim();
  const pendingDescription = !description && needsDescription(entry);
  const sourceKey = sourceLabelKey(entry.source);

  return (
    <div
      className={`group relative flex flex-col gap-2.5 rounded-xl border p-3.5 transition-colors ${
        featured ? "min-h-[150px]" : "min-h-[128px]"
      }`}
      style={{
        background: "var(--app-home-surface)",
        borderColor: featured
          ? "color-mix(in srgb, var(--app-accent) 35%, var(--app-home-border))"
          : "var(--app-home-border)",
      }}
      data-testid="skill-market-card"
      data-skill-id={entry.id}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold"
          style={{
            background: `color-mix(in srgb, var(--app-tag-${tone}) 18%, transparent)`,
            color: `var(--app-tag-${tone})`,
          }}
        >
          {iconGlyph(entry.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className="truncate text-[13px] font-medium"
              style={{ color: "var(--app-text-primary)" }}
              title={entry.name}
            >
              {entry.name}
            </span>
            {installed && (
              <Check className="size-3.5 shrink-0" style={{ color: "var(--app-status-success)" }} aria-label={t("installed")} />
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            <span className="truncate" title={repo ?? undefined}>{repo ?? t(sourceKey)}</span>
            {installs && (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">{t("installsCompact", { value: installs })}</span>
              </>
            )}
          </div>
        </div>
        {entry.homepageUrl && (
          <button
            type="button"
            aria-label={t("openSource")}
            title={t("openSource")}
            className="rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            style={{ color: "var(--app-icon-inactive)" }}
            onClick={() => void openExternal(entry.homepageUrl as string)}
          >
            <ExternalLink className="size-3.5" />
          </button>
        )}
      </div>

      <p
        className="line-clamp-2 flex-1 text-xs leading-relaxed"
        style={{ color: description ? "var(--app-text-secondary)" : "var(--app-text-tertiary)" }}
        title={description}
      >
        {description ?? (pendingDescription ? t("loadingDescription") : t("noDescription"))}
      </p>

      <div className="flex items-center justify-between gap-2">
        <span
          className="truncate rounded-full px-2 py-0.5 text-[10px]"
          style={{
            background: "color-mix(in srgb, var(--app-text-primary) 6%, transparent)",
            color: "var(--app-text-tertiary)",
          }}
        >
          {t(sourceKey)}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {installed && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={busy}
              onClick={() => onRemove(entry)}
              aria-label={t("remove")}
              title={t("remove")}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
          <Button
            type="button"
            variant={installed ? "outline" : "default"}
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={busy}
            onClick={() => onInstall(entry)}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            {busy ? t("installing") : installed ? t("reinstall") : t("install")}
          </Button>
        </div>
      </div>
    </div>
  );
}
