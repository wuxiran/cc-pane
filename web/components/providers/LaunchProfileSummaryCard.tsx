import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, Link2, Plus, Save, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import type { LaunchProfile, LaunchProfileDraft, LaunchProfileResolution } from "@/types";
import type { KnownCliTool } from "@/types/terminal";
import type { Workspace } from "@/types/workspace";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { profileDisplayName, toolLabel } from "./launchProfileHelpers";
import { HintIcon } from "./launchProfileParts";
import LaunchProfileWorkspaceAccountRow from "./LaunchProfileWorkspaceAccountRow";

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
  /** 列表展开模式下：点行头收起 */
  onCollapse?: () => void;
  /** 标题即别名：给了就把标题渲染成可直接编辑的输入框（系统默认名称固定，不给） */
  onRename?: (name: string) => void;
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
  onCollapse,
  onRename,
}: LaunchProfileSummaryCardProps) {
  const { t } = useTranslation(["providers", "common"]);
  const skillCompatibility = preview?.skillCompatibility ?? null;
  const deliveryModeLabels = {
    nativeCommand: t("skillDeliveryMode.nativeCommand"),
    nativeSkill: t("skillDeliveryMode.nativeSkill"),
    piSkill: t("skillDeliveryMode.piSkill"),
    sessionPrompt: t("skillDeliveryMode.sessionPrompt"),
  } as const;
  const compatibilityReasonLabels = {
    cliNotRegistered: t("skillCompatibilityReason.cliNotRegistered"),
    noSkillDelivery: t("skillCompatibilityReason.noSkillDelivery"),
    mcpUnsupported: t("skillCompatibilityReason.mcpUnsupported"),
    ccpanesMcpDisabled: t("skillCompatibilityReason.ccpanesMcpDisabled"),
  } as const;
  const deliveryModesLabel = skillCompatibility?.deliveryModes
    .map((mode) => deliveryModeLabels[mode])
    .join(" · ");
  const compatibilityReason = skillCompatibility?.reason
    ? compatibilityReasonLabels[skillCompatibility.reason]
    : null;

  // 只在有能力缺口时展示跨 CLI Skill 诊断；全部就绪时它是噪音
  const compatibilityIssue = skillCompatibility
    && !(skillCompatibility.canUsePortableSkills
      && skillCompatibility.canControlOrchestration
      && skillCompatibility.canReportResult);
  const showWarnings = !isNewProfile && (preview?.warnings.length ?? 0) > 0;

  return (
    <>
    {/* 吸顶行头：标题 + 动作。外层卡片由列表提供（展开的那一行），这里不再自带卡片 */}
    <div className="sticky top-0 z-10 rounded-t-lg bg-[var(--app-panel-bg)]">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {onCollapse && (
              <button
                type="button"
                aria-expanded
                aria-label={t("profileRowCollapse")}
                className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--app-text-tertiary)] hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
                onClick={onCollapse}
              >
                <ChevronDown size={14} />
              </button>
            )}
            {onRename ? (
              <input
                aria-label={t("fieldAlias")}
                className="min-w-0 max-w-md flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 -ml-1.5 text-[length:var(--text-title)] font-semibold outline-none transition-colors hover:border-[var(--app-border)] focus:border-[var(--app-accent)]"
                style={{ color: "var(--app-text-primary)" }}
                value={draft.alias ?? draft.name ?? ""}
                placeholder={currentTitle}
                onChange={(event) => onRename(event.target.value)}
              />
            ) : (
              <h2 className="truncate text-[length:var(--text-title)] font-semibold" style={{ color: "var(--app-text-primary)" }}>
                {currentTitle}
              </h2>
            )}
            {(isSystemDefaultSelected || selectedProfile?.isDefault) && <Badge variant="secondary" className="text-[length:var(--text-micro)]">{t("common:default")}</Badge>}
            {!isSystemDefaultSelected && (
              <Badge variant="outline" className="text-[length:var(--text-micro)]">{toolLabel(activeTool, t)}</Badge>
            )}
            {isSystemDefaultSelected && draft.description ? <HintIcon text={draft.description} /> : null}
          </div>
        </div>

        {/* 按钮优先级（docs/46 §6）：仅「保存」为主按钮；设默认/删除降为图标按钮 */}
        <div className="flex items-center gap-1.5">
          {isSystemDefaultSelected ? (
            <>
              {selectedProfileId && (
                <Button size="xs" variant="outline" onClick={onToggleWorkspaceBindingOpen}>
                  <Link2 size={14} /> {t("workspaceBindingCount", { count: boundWorkspaces.length })}
                </Button>
              )}
              <Button size="xs" variant="outline" onClick={onCopySystemDefault}>
                <Plus size={14} /> {t("copyAsProfile")}
              </Button>
              <Button size="xs" onClick={onSave}>
                <Save size={14} /> {t("saveDefault")}
              </Button>
            </>
          ) : (
            <>
              {selectedProfile && (
                <Button size="xs" variant="outline" onClick={onToggleWorkspaceBindingOpen}>
                  <Link2 size={14} /> {t("workspaceBindingCount", { count: boundWorkspaces.length })}
                </Button>
              )}
              {selectedProfile && !selectedProfile.isDefault && (
                <IconTooltipButton label={t("setAsDefault")} onClick={onSetDefault} className="h-7 w-7">
                  <Star size={14} />
                </IconTooltipButton>
              )}
              {selectedProfile && (
                <IconTooltipButton
                  label={t("common:delete")}
                  onClick={onDelete}
                  className="h-7 w-7 text-[var(--app-status-danger)] hover:text-[var(--app-status-danger)]"
                >
                  <Trash2 size={14} />
                </IconTooltipButton>
              )}
              <Button size="xs" onClick={onSave}>
                <Save size={14} /> {isNewProfile ? t("saveAsProfile") : t("common:save")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>

    {(compatibilityIssue || showWarnings || (!isNewProfile && workspaceContext) || (workspaceBindingOpen && selectedProfileId)) && (
    <div>
      {!isNewProfile && workspaceContext && (
        <div className="px-4 pt-2.5 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
          <span>
            {t("previewBoundProfile")}
            {workspaceContext.launchProfileId ? profileDisplayName(profiles.find((p) => p.id === workspaceContext.launchProfileId) ?? { name: workspaceContext.launchProfileId, alias: null }) : t("notBound")}
          </span>
          <LaunchProfileWorkspaceAccountRow workspace={workspaceContext} />
        </div>
      )}

      {compatibilityIssue && skillCompatibility && (
        <div
          data-testid="skill-compatibility"
          className="mx-4 mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-bg)] px-3 py-2 text-xs text-[var(--app-status-warning)]"
        >
          <AlertTriangle size={13} className="shrink-0" />
          <span className="font-medium">{t("skillCompatibility")}</span>
          <span>{deliveryModesLabel || t("skillDeliveryMode.none")}</span>
          {([
            [skillCompatibility.canUsePortableSkills, "portableSkillReady", "portableSkillUnavailable"],
            [skillCompatibility.canControlOrchestration, "orchestrationReady", "orchestrationUnavailable"],
            [skillCompatibility.canReportResult, "resultReportingReady", "resultReportingUnavailable"],
          ] as const).map(([ok, readyKey, missingKey]) => (
            <Badge key={readyKey} variant={ok ? "secondary" : "outline"} className="text-[length:var(--text-micro)]">
              {t(ok ? readyKey : missingKey)}
            </Badge>
          ))}
          {compatibilityReason && <span>{compatibilityReason}</span>}
        </div>
      )}

      {showWarnings && preview ? (
        <div className="mx-4 mt-2.5 space-y-1.5">
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
          <div className="mb-2 flex items-center gap-2 text-[length:var(--text-row)] font-semibold" style={{ color: "var(--app-text-primary)" }}>
            <Link2 size={14} className="text-[var(--app-text-tertiary)]" />
            {t("workspaceBinding")}
            <Badge variant="secondary" className="text-[length:var(--text-micro)]">{boundWorkspaces.length}</Badge>
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
      <div className="h-2.5" />
    </div>
    )}
    </>
  );
}
