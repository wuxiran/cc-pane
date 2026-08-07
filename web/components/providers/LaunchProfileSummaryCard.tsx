import { useTranslation } from "react-i18next";
import { AlertTriangle, Link2, Plus, Save, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import type { LaunchProfile, LaunchProfileDraft, LaunchProfileResolution } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import type { Workspace } from "@/types/workspace";
import { SummaryStat } from "./launchProfileParts";
import { profileDisplayName, runtimeLabel, toolLabel } from "./launchProfileHelpers";

interface LaunchProfileSummaryCardProps {
  draft: LaunchProfileDraft;
  activeTool: KnownCliTool;
  currentTitle: string;
  isSystemDefaultSelected: boolean;
  isNewProfile: boolean;
  selectedProfile: LaunchProfile | null;
  selectedProfileId: string | null;
  profiles: LaunchProfile[];
  preview: LaunchProfileResolution | null;
  previewProviderLabel: string;
  previewModelLabel: string;
  previewMcpCount: number;
  previewSkillCount: number;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceContext: Workspace | null;
  boundWorkspaces: Workspace[];
  bindingWorkspaceName: string | null;
  workspaceBindingOpen: boolean;
  onToggleWorkspaceBindingOpen: () => void;
  onToggleWorkspaceBinding: (workspaceName: string, next: boolean) => void;
  onCopySystemDefault: () => void;
  onSave: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
}

/** 运行配置页概要卡：标题+动作行、summary strip、warnings、工作空间绑定分组（纯展示，不碰 store） */
export default function LaunchProfileSummaryCard({
  draft,
  activeTool,
  currentTitle,
  isSystemDefaultSelected,
  isNewProfile,
  selectedProfile,
  selectedProfileId,
  profiles,
  preview,
  previewProviderLabel,
  previewModelLabel,
  previewMcpCount,
  previewSkillCount,
  workspaces,
  workspacesLoading,
  workspaceContext,
  boundWorkspaces,
  bindingWorkspaceName,
  workspaceBindingOpen,
  onToggleWorkspaceBindingOpen,
  onToggleWorkspaceBinding,
  onCopySystemDefault,
  onSave,
  onSetDefault,
  onDelete,
}: LaunchProfileSummaryCardProps) {
  const { t } = useTranslation(["providers", "common"]);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
              {currentTitle}
            </h2>
            {(isSystemDefaultSelected || selectedProfile?.isDefault) && <Badge variant="secondary" className="text-[10px]">{t("common:default")}</Badge>}
            {!isSystemDefaultSelected && (
              <Badge variant="outline" className="text-[10px]">{toolLabel(activeTool, t)}</Badge>
            )}
            <Badge variant="outline" className="text-[10px]">{runtimeLabel(draft.targetRuntime ?? null, t)}</Badge>
          </div>
        </div>

        {/* 按钮优先级（docs/46 §6）：仅「保存」为主按钮，绑定/复制恒 outline，删除走 ghost+危险前景 */}
        <div className="flex flex-wrap gap-1.5">
          {isSystemDefaultSelected ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={!selectedProfileId}
                onClick={onToggleWorkspaceBindingOpen}
              >
                <Link2 size={14} /> {selectedProfileId ? t("workspaceBindingCount", { count: boundWorkspaces.length }) : t("bindAfterSave")}
              </Button>
              <Button size="xs" variant="outline" onClick={onCopySystemDefault}>
                <Plus size={14} /> {t("copyAsProfile")}
              </Button>
              <Button size="xs" onClick={onSave}>
                <Save size={14} /> {t("saveDefault")}
              </Button>
            </>
          ) : (
            <>
              {selectedProfile && !selectedProfile.isDefault && (
                <Button size="xs" variant="outline" onClick={onSetDefault}>
                  <Star size={14} /> {t("setAsDefault")}
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                disabled={!selectedProfile}
                onClick={onToggleWorkspaceBindingOpen}
              >
                <Link2 size={14} /> {selectedProfile ? t("workspaceBindingCount", { count: boundWorkspaces.length }) : t("bindAfterSave")}
              </Button>
              {selectedProfile && (
                <Button size="xs" variant="ghost" className="text-[var(--app-status-danger)]" onClick={onDelete}>
                  <Trash2 size={14} /> {t("common:delete")}
                </Button>
              )}
              <Button size="xs" onClick={onSave}>
                <Save size={14} /> {isNewProfile ? t("saveAsProfile") : t("common:save")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* summary strip：无边框 stat 组 + 竖分隔线，替代四个「假输入框」 */}
      <div className="mx-4 grid grid-cols-2 divide-x divide-[var(--app-border)]/60 border-t border-[var(--app-border)]/60 md:grid-cols-4">
        <SummaryStat label={t("fieldProviderModel")} value={`${previewProviderLabel} / ${previewModelLabel}`} />
        <SummaryStat label="MCP" value={t("enabledCount", { count: previewMcpCount })} />
        <SummaryStat label="Skill" value={t("enabledCount", { count: previewSkillCount })} />
        <SummaryStat
          label={t("workspace")}
          value={selectedProfileId ? t("boundCount", { count: boundWorkspaces.length }) : t("notSaved")}
          meta={workspaceContext ? workspaceContext.name : undefined}
        />
      </div>

      {/* 原「生效预览」卡并入：上下文提示 + 解析 warnings（色+形冗余） */}
      {!isNewProfile && (
        <div className="px-4 pb-2 pt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
          {workspaceContext && (
            <span>
              {t("previewBoundProfile")}
              {workspaceContext.launchProfileId ? profileDisplayName(profiles.find((p) => p.id === workspaceContext.launchProfileId) ?? { name: workspaceContext.launchProfileId, alias: null }) : t("notBound")}
            </span>
          )}
          {workspaces.length === 0 && <span>{t("previewCreateWorkspaceHint")}</span>}
          {!workspaceContext && workspaces.length > 0 && <span>{t("previewSelectWorkspaceHint")}</span>}
        </div>
      )}
      {!isNewProfile && preview?.warnings.length ? (
        <div className="mx-4 mb-1 space-y-1.5">
          {preview.warnings.map((warning) => (
            <div
              key={warning}
              className="flex items-start gap-2 rounded-md border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] px-3 py-2 text-xs text-[var(--app-status-warning)]"
            >
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      ) : null}

      {workspaceBindingOpen && selectedProfileId && (
        <div className="mx-4 mb-1 mt-2 border-t border-[var(--app-border)]/60 pt-3">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
            <Link2 size={14} className="text-[var(--app-text-tertiary)]" />
            {t("workspaceBinding")}
            <Badge variant="secondary" className="text-[10px]">{boundWorkspaces.length}</Badge>
          </div>
          {workspacesLoading && workspaces.length === 0 ? (
            <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {t("loadingWorkspaces")}
            </div>
          ) : workspaces.length === 0 ? (
            <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {t("noWorkspaces")}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
              {workspaces.map((workspace) => {
                const checked = workspace.launchProfileId === selectedProfileId;
                const currentProfile = workspace.launchProfileId
                  ? profiles.find((profile) => profile.id === workspace.launchProfileId)
                  : null;
                const currentLabel = currentProfile
                  ? profileDisplayName(currentProfile)
                  : workspace.launchProfileId ? workspace.launchProfileId : t("notBound");
                return (
                  <CheckboxRow
                    key={workspace.id}
                    checked={checked}
                    disabled={bindingWorkspaceName === workspace.name}
                    onCheckedChange={(next) => onToggleWorkspaceBinding(workspace.name, next)}
                    label={workspace.alias || workspace.name}
                    trailing={checked ? t("currentProfile") : currentLabel}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
