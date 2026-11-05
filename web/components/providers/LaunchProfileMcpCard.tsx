import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Cable } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import { SegmentedTabs } from "@/components/ui/segmented";
import { useCliTools } from "@/hooks/useCliTools";
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

/** per-CLI 的注入形态提示：桥接/stdio-only 与 Claude 的全量注入体验不同，说清楚。 */
const TOOL_MCP_HINT_KEYS: Partial<
  Record<KnownCliTool, "mcpBridgePiHint" | "mcpStdioOnlyJcodeHint">
> = {
  pi: "mcpBridgePiHint",
  jcode: "mcpStdioOnlyJcodeHint",
};

/** 启动档只管总策略；每个 MCP 开给哪些启动档统一在资源库改。 */
export default function LaunchProfileMcpCard({ draft, setDraft, activeTool, setMcpMode }: LaunchProfileMcpCardProps) {
  const { t } = useTranslation(["providers", "common", "settings"]);
  const { tools: cliTools } = useCliTools();
  const mcpDisabled = draft.mcpPolicy.mode === "disabled";
  const toolHintKey = TOOL_MCP_HINT_KEYS[activeTool];
  // MCP 门控走后端能力位（docs/104），不再硬编码排除名单：pi（扩展桥）/
  // omp（原生 .omp/mcp.json）/ jcode（原生 .jcode/mcp.json，仅 stdio）已接入。
  // 能力缺失（加载中/旧 daemon 不发）按「支持」处理——用能力声明去禁用实际
  // 可用的功能，比不置灰更糟（口径同 launcherCapabilities）。
  const capabilities = cliTools.find((tool) => tool.id === activeTool)?.capabilities;
  const mcpSupported = capabilities ? capabilities.supportsMcp : true;

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

      {toolHintKey && (
        <div
          data-testid="mcp-tool-hint"
          className="mt-2 rounded-md border border-dashed border-[var(--app-border)] px-3 py-2 text-xs"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {t(toolHintKey)}
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
