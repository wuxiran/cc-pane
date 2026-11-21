import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Cable } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import { SegmentedTabs } from "@/components/ui/segmented";
import { hasAnyMcp, mcpProfileHints } from "@/lib/cliInjectionRules";
import { useInjectionProfile } from "@/stores/useCliInjectionProfilesStore";
import { openResourceLibrary } from "@/stores/useResourceLibraryStore";
import type { LaunchProfileDraft } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import { Section } from "./launchProfileParts";

interface LaunchProfileMcpCardProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  activeTool: KnownCliTool;
  setMcpMode: (mode: LaunchProfileDraft["mcpPolicy"]["mode"]) => void;
}

/** 启动档只管总策略；每个 MCP 开给哪些启动档统一在资源库改。 */
export default function LaunchProfileMcpCard({ draft, setDraft, activeTool, setMcpMode }: LaunchProfileMcpCardProps) {
  const { t } = useTranslation(["providers", "common", "settings"]);
  const mcpDisabled = draft.mcpPolicy.mode === "disabled";
  // 门控与注入形态提示都读 CLI 注入描述（docs/110 单源），不再维护 per-CLI 提示表。
  const profile = useInjectionProfile(activeTool);
  const mcpSupported = activeTool === "none" || hasAnyMcp(profile);
  const hints = mcpProfileHints(profile);

  if (!mcpSupported) {
    return (
      <Section
        title="MCP"
        description={t("sectionMcpDesc")}
        icon={<Cable size={16} />}
        headerActions={<Badge variant="outline" className="text-[length:var(--text-micro)]">{t("mcpUnsupported")}</Badge>}
      >
        <div
          data-testid="mcp-unsupported"
          className="rounded-md border border-dashed border-[var(--app-border)] px-3 py-3 text-xs"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {t("mcpUnsupportedHint")}
        </div>
      </Section>
    );
  }

  return (
    <Section
      title="MCP"
      description={t("sectionMcpDesc")}
      icon={<Cable size={16} />}
      headerActions={
        <Button size="sm" variant="outline" onClick={() => openResourceLibrary("mcp")} data-testid="open-mcp-library">
          <Boxes size={14} />
          {t("settings:resourceLibrary.openInLibrary")}
        </Button>
      }
    >
      <SegmentedTabs
        size="sm"
        value={draft.mcpPolicy.mode}
        onValueChange={(mode) => setMcpMode(mode)}
        items={(["default", "custom", "disabled"] as const).map((mode) => ({
          value: mode,
          label: t(`mcpMode.${mode}`),
        }))}
      />

      {hints.length > 0 && (
        <div
          data-testid="mcp-tool-hint"
          className="mt-2 space-y-1 rounded-md border border-dashed border-[var(--app-border)] px-3 py-2 text-xs"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {hints.map((hint) => (
            <div key={hint}>{t(`mcpProfileHint.${hint}`)}</div>
          ))}
        </div>
      )}

      <div className="mt-2.5 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
        {mcpDisabled
          ? t("mcpDisabledHint")
          : draft.mcpPolicy.mode === "custom"
            ? t("mcpCustomHint")
            : t("mcpDefaultHint")}
      </div>

      {!mcpDisabled && (
        <div className="mt-3">
          <CheckboxRow
            checked={draft.mcpPolicy.includeSharedMcp}
            onCheckedChange={(next) => setDraft((current) => ({ ...current, mcpPolicy: { ...current.mcpPolicy, includeSharedMcp: next } }))}
            label={t("sharedMcpService")}
            description={t("sharedMcpServiceDesc")}
          />
        </div>
      )}
    </Section>
  );
}
