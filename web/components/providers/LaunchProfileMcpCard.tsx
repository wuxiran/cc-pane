import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Cable, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import { CollapsibleCheckGroup } from "@/components/ui/CollapsibleCheckGroup";
import { SegmentedTabs } from "@/components/ui/segmented";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import SharedMcpSection from "@/components/settings/SharedMcpSection";
import { useCliTools } from "@/hooks/useCliTools";
import type { LaunchProfileDraft } from "@/types";
import type { SharedMcpServerInfo } from "@/types/shared-mcp";
import type { KnownCliTool } from "@/types/terminal";
import { GroupSearchInput, Section } from "./launchProfileParts";
import { isSharedMcpServerSelected, selectedSharedMcpCount } from "./launchProfileHelpers";

interface LaunchProfileMcpCardProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  servers: SharedMcpServerInfo[];
  mcpManagerOpen: boolean;
  setMcpManagerOpen: (open: boolean) => void;
  activeTool: KnownCliTool;
  setMcpMode: (mode: LaunchProfileDraft["mcpPolicy"]["mode"]) => void;
  toggleServer: (name: string) => void;
}

/** per-CLI 的注入形态提示：桥接/stdio-only 与 Claude 的全量注入体验不同，说清楚。 */
const TOOL_MCP_HINT_KEYS: Partial<
  Record<KnownCliTool, "mcpBridgePiHint" | "mcpStdioOnlyJcodeHint">
> = {
  pi: "mcpBridgePiHint",
  jcode: "mcpStdioOnlyJcodeHint",
};

export default function LaunchProfileMcpCard({
  draft,
  setDraft,
  servers,
  mcpManagerOpen,
  setMcpManagerOpen,
  activeTool,
  setMcpMode,
  toggleServer,
}: LaunchProfileMcpCardProps) {
  const { t } = useTranslation(["providers", "common"]);
  const [query, setQuery] = useState("");
  const { tools: cliTools } = useCliTools();
  const mcpDisabled = draft.mcpPolicy.mode === "disabled";
  const sharedMcpNames = servers.map((server) => server.name);
  const sharedMcpSelectedCount = selectedSharedMcpCount(draft.mcpPolicy, sharedMcpNames);
  const normalizedQuery = query.trim().toLowerCase();
  const toolHintKey = TOOL_MCP_HINT_KEYS[activeTool];
  // MCP 门控走后端能力位（docs/104），不再硬编码排除名单：pi（扩展桥）/
  // omp（原生 .omp/mcp.json）/ jcode（原生 .jcode/mcp.json，仅 stdio）已接入。
  // 能力缺失（加载中/旧 daemon 不发）按「支持」处理——用能力声明去禁用实际
  // 可用的功能，比不置灰更糟（口径同 launcherCapabilities）。
  const capabilities = cliTools.find((tool) => tool.id === activeTool)?.capabilities;
  const mcpSupported = capabilities ? capabilities.supportsMcp : true;
  // 过滤只影响可见行；计数仍按全量，避免搜索时看着像「服务器变少了」
  const visibleServers = useMemo(
    () => normalizedQuery
      ? servers.filter((server) => server.name.toLowerCase().includes(normalizedQuery))
      : servers,
    [normalizedQuery, servers],
  );

  if (!mcpSupported) {
    return (
      <Section
        title="MCP"
        description={t("sectionMcpDesc")}
        icon={<Cable size={16} />}
        headerActions={<Badge variant="outline" className="text-[10px]">{t("mcpUnsupported")}</Badge>}
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
                <div className="flex items-center gap-2">
                  <GroupSearchInput value={query} onChange={setQuery} placeholder={t("searchMcpPlaceholder")} />
                  <Button size="sm" variant="outline" onClick={() => setMcpManagerOpen(true)}>
                    <Settings2 size={14} />
                    {t("manageSharedMcp")}
                  </Button>
                </div>
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
                <div className="mt-3 space-y-1.5">
                  <CheckboxRow
                    checked={draft.mcpPolicy.includeCcpanesMcp}
                    onCheckedChange={(next) => setDraft((current) => ({ ...current, mcpPolicy: { ...current.mcpPolicy, includeCcpanesMcp: next } }))}
                    label="CC-Panes MCP"
                    description={t("ccpanesMcpDesc")}
                  />
                  <CheckboxRow
                    checked={draft.mcpPolicy.includeSharedMcp}
                    onCheckedChange={(next) => setDraft((current) => ({ ...current, mcpPolicy: { ...current.mcpPolicy, includeSharedMcp: next } }))}
                    label={t("sharedMcpService")}
                    description={t("sharedMcpServiceDesc")}
                  />
                </div>
              )}

              {!mcpDisabled && draft.mcpPolicy.includeSharedMcp && (
                <div className="mt-3">
                  {servers.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("sharedMcpEmpty")}
                    </div>
                  ) : (
                    <CollapsibleCheckGroup
                      title={t("sharedMcpSelection")}
                      total={servers.length}
                      enabledCount={sharedMcpSelectedCount}
                      enabledNames={servers.filter((server) => isSharedMcpServerSelected(draft.mcpPolicy, server.name)).map((server) => server.name)}
                      formatCount={(total, enabled) => t("groupCount", { total, enabled })}
                      formatMore={(hidden) => t("expandMore", { count: hidden })}
                      forceOpen={normalizedQuery.length > 0}
                    >
                      {visibleServers.length === 0 ? (
                        <div className="px-1 py-3 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
                          {t("searchNoMatch")}
                        </div>
                      ) : visibleServers.map((server) => {
                        const checked = isSharedMcpServerSelected(draft.mcpPolicy, server.name);
                        return (
                          <CheckboxRow
                            key={server.name}
                            checked={checked}
                            onCheckedChange={() => toggleServer(server.name)}
                            label={server.name}
                            trailing={
                              <Badge variant={server.status === "running" ? "default" : "secondary"} className="text-[10px]">
                                {typeof server.status === "string" ? server.status : "failed"}
                              </Badge>
                            }
                          />
                        );
                      })}
                    </CollapsibleCheckGroup>
                  )}
                </div>
              )}

              {/* 共享 MCP 管理改为右滑抽屉，卡内不再嵌整个 SharedMcpSection（docs/46 §6 禁卡片嵌套） */}
              <Sheet open={mcpManagerOpen} onOpenChange={setMcpManagerOpen}>
                <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
                  <SheetHeader>
                    <SheetTitle>{t("manageSharedMcp")}</SheetTitle>
                  </SheetHeader>
                  <div className="px-1 pb-6">
                    <SharedMcpSection />
                  </div>
                </SheetContent>
              </Sheet>
            </Section>
  );
}
