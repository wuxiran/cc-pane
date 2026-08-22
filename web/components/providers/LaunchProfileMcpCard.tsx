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
  const mcpDisabled = draft.mcpPolicy.mode === "disabled";
  const sharedMcpNames = servers.map((server) => server.name);
  const sharedMcpSelectedCount = selectedSharedMcpCount(draft.mcpPolicy, sharedMcpNames);
  const normalizedQuery = query.trim().toLowerCase();
  const mcpSupported = activeTool !== "pi" && activeTool !== "omp";
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
                              <Badge variant={server.status === "Running" ? "default" : "secondary"} className="text-[10px]">
                                {typeof server.status === "string" ? server.status : "Failed"}
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
