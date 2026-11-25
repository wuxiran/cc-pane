// 运行配置列表里收起的一行：名称 + 默认标记 + 一行摘要（凭证 · MCP · Skill · YOLO），点击展开。
import { useTranslation } from "react-i18next";
import { ChevronRight, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { LaunchProfileDraft, Provider } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { credentialOptions, selectedCredential } from "./launchProfileCredential";

type RowSource = Pick<LaunchProfileDraft, "providerId" | "providerAccountId" | "mcpPolicy" | "skillPolicy" | "yoloMode">;

export function useProfileRowSummary(providers: readonly Provider[], tool: KnownCliTool) {
  const { t } = useTranslation(["providers", "launcher"]);
  return (source: RowSource): string => {
    let credential = t("credentialKind.cli");
    if (source.providerId) {
      const options = credentialOptions(providers, tool, t("launcher:account.defaultLogin"));
      const selected = selectedCredential(options, providers, source.providerId, source.providerAccountId);
      credential = selected
        ? `${t(`credentialKind.${selected.kind}`)} · ${selected.label}`
        : source.providerId;
    }
    const parts = [
      credential,
      t("profileRowMcp", { mode: t(`mcpMode.${source.mcpPolicy.mode}`) }),
      t("profileRowSkill", { mode: t(`skillMode.${source.skillPolicy.mode}`) }),
    ];
    if (source.yoloMode) parts.push(t("profileRowYolo"));
    return parts.join(" · ");
  };
}

interface LaunchProfileRowProps {
  label: string;
  summary: string;
  isDefault?: boolean;
  /** 当前选中但被收起：保留一点强调 */
  current?: boolean;
  onClick: () => void;
}

export default function LaunchProfileRow({ label, summary, isDefault, current, onClick }: LaunchProfileRowProps) {
  const { t } = useTranslation(["providers", "common"]);
  return (
    <Card className={current ? "shadow-[inset_0_0_0_1px_var(--app-accent)]" : undefined}>
      <button
        type="button"
        aria-expanded={false}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-4 py-2.5 text-left hover:bg-[var(--app-hover)]"
        onClick={onClick}
      >
        <ChevronRight size={14} className="shrink-0 text-[var(--app-text-tertiary)]" />
        <span className="shrink-0 text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>
          {label}
        </span>
        {isDefault && (
          <span className="shrink-0 text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">· {t("common:default")}</span>
        )}
        <span className="ml-3 min-w-0 truncate text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
          {summary}
        </span>
      </button>
    </Card>
  );
}

export function LaunchProfileAddRow({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("providers");
  return (
    <button
      type="button"
      data-testid="launch-profile-add-row"
      className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-[var(--app-border)] px-4 py-2.5 text-xs text-[var(--app-text-tertiary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
      onClick={onClick}
    >
      <Plus size={13} /> {t("add")}
    </button>
  );
}
