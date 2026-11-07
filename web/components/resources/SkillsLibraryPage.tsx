// 资源库 · 技能（照 magpie 技能页）：安装卡 → 资源库中 → 内置 / 工作空间 / CLI 自带 → Agent 中已有 → 发现。
// 每行末尾的开关决定开给哪些启动档；注入方式不变，按会话内联，不写 ~/.claude 等目录。
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compass, FolderOpen } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { resolveWorkspaceLaunchProfile } from "@/components/providers/launchProfileHelpers";
import RemoteRuntimeNotice from "@/components/providers/RemoteRuntimeNotice";
import { Button } from "@/components/ui/button";
import { toastErr } from "@/lib/feedback";
import { settingsService } from "@/services";
import { useActivityBarStore } from "@/stores";
import { readSkillsCheckedAt, useSkillLibraryStore } from "@/stores/useSkillLibraryStore";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import FoundSkillsSection from "./FoundSkillsSection";
import { profileChipLabel, profileName, ScopeSelect, ShownProfilesMenu, useLibraryProfiles, useResourceScope } from "./libraryChrome";
import ProfileChips from "./ProfileChips";
import { setSkillResource, skillChipState, type ChipBlockReason, type ProfileSkillResource } from "./resourceCenterModel";
import SkillBuiltinSections from "./SkillBuiltinSections";
import { RemoveGoneDialog, UpdateEditedDialog } from "./SkillConfirmDialogs";
import SkillDetailPanel, { type SkillDetailTarget } from "./SkillDetailPanel";
import SkillInstallCard from "./SkillInstallCard";
import SkillLibrarySection, { librarySkillKey } from "./SkillLibrarySection";
import { autoCheckDue, isTracked } from "./skillLibraryModel";
import { useSkillLibraryActions } from "./useSkillLibraryActions";

// 发现区带市场目录和卡片，首屏用不到，单独分包
const SkillDiscoverSection = lazy(() => import("./SkillDiscoverSection"));

export default function SkillsLibraryPage() {
  const { t } = useTranslation("settings");
  const { t: tProviders } = useTranslation("providers");
  const active = useActivityBarStore((s) => s.appViewMode === "resources");
  const { workspaceName, workspace } = useResourceScope();
  const { profiles, loadProfiles, shown, shownIds, toggleShown, overlay, apply } = useLibraryProfiles(active);
  const skills = useSkillLibraryStore((s) => s.skills);
  const loaded = useSkillLibraryStore((s) => s.loaded);
  const checks = useSkillLibraryStore((s) => s.checks);
  const checking = useSkillLibraryStore((s) => s.checking);
  const load = useSkillLibraryStore((s) => s.load);
  const actions = useSkillLibraryActions(loadProfiles);
  const { checkAll } = actions;

  const discoverRef = useRef<HTMLDivElement>(null);
  const autoChecked = useRef(false);
  const [selected, setSelected] = useState<SkillDetailTarget | null>(null);
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null);

  useEffect(() => {
    if (!active) return;
    const refresh = () => void load().catch((error) => handleErrorSilent(error, "load skill library"));
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [active, load]);

  // 进页面时距上次检查超过 12 小时，静默检查一次
  useEffect(() => {
    if (!active || !loaded || autoChecked.current || checking) return;
    if (!skills.some(isTracked) || !autoCheckDue(readSkillsCheckedAt(), Date.now())) return;
    autoChecked.current = true;
    void checkAll(true);
  }, [active, loaded, skills, checking, checkAll]);

  // 列表刷新后详情跟上最新数据；被删掉的就关掉
  const current = selected?.kind === "library"
    ? (() => {
      const skill = skills.find((item) => item.id === selected.skill.id);
      return skill ? { ...selected, skill } : null;
    })()
    : selected;

  const workspaceProfile = resolveWorkspaceLaunchProfile(workspace, profiles);

  const chips = (key: string, name: string, resource: ProfileSkillResource) => (
    <ProfileChips
      resourceName={name}
      items={shown.map((profile) => ({
        profileId: profile.id,
        label: profileChipLabel(profile, tProviders),
        state: skillChipState(overlay[profile.id]?.skillPolicy ?? profile.skillPolicy, resource),
      }))}
      onChange={(profileId, on) => {
        setNotice({ key, text: t("resourceCenter.nextLaunch") });
        apply(profileId, (draft) => setSkillResource(draft, resource, on));
      }}
      onBlocked={(reason: ChipBlockReason, profileId) => {
        const profile = shown.find((item) => item.id === profileId);
        setNotice({ key, text: t(`resourceCenter.blocked.${reason}`, { name: profile ? profileName(profile) : "" }) });
      }}
    />
  );
  const noticeFor = (key: string) => (notice?.key === key ? notice.text : null);
  const toggleSelected = (target: SkillDetailTarget) => setSelected(current?.key === target.key ? null : target);

  const openFolder = async () => {
    try {
      const info = await settingsService.getDataDirInfo();
      await revealItemInDir(`${info.currentPath}/skills/user`);
    } catch (error) {
      toastErr(t("skillLibrary.actionFailed", { error: translateError(error) }));
    }
  };
  const scrollToDiscover = () => {
    discoverRef.current?.scrollIntoView({ block: "start" });
    discoverRef.current?.querySelector("input")?.focus();
  };

  const detailSource = (target: SkillDetailTarget) => {
    switch (target.kind) {
      case "library": return t("skillLibrary.inLibrary");
      case "builtin": return t("skillLibrary.builtinTitle");
      case "workspace": return t("skillLibrary.workspaceTitle", { name: target.workspaceName });
      case "external": return target.skill.path;
    }
  };

  return (
    <div className="flex h-full" data-testid="skills-library-page" style={{ background: "var(--app-panel-bg)" }}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3 pt-5">
          <h1 className="mr-auto text-[length:var(--text-title)] font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("resourceLibrary.skills")}</h1>
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={scrollToDiscover}><Compass size={13} className="mr-1" />{t("resourceLibrary.discover")}</Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => void openFolder()}><FolderOpen size={13} className="mr-1" />{t("resourceLibrary.folder")}</Button>
          <ScopeSelect onChange={() => setSelected(null)} />
          <ShownProfilesMenu profiles={profiles} shownIds={shownIds} onToggle={toggleShown} />
        </header>

        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <RemoteRuntimeNotice workspace={workspace} profile={workspaceProfile} subject="skills" className="mb-3" />
          <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.intro")}</p>
          {profiles.length === 0 && <p className="mb-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("resourceCenter.noProfiles")}</p>}
          <SkillInstallCard />
          <SkillLibrarySection
            skills={skills}
            checks={checks}
            checking={checking}
            selectedKey={current?.key ?? null}
            onSelect={(skill) => toggleSelected({ kind: "library", key: librarySkillKey(skill), skill })}
            actions={actions}
            chips={chips}
            notice={noticeFor}
          />
          <SkillBuiltinSections workspaceName={workspaceName} selectedKey={current?.key ?? null} onSelect={toggleSelected} chips={chips} notice={noticeFor} />
          <FoundSkillsSection active={active} />
          <div ref={discoverRef} className="mt-6 scroll-mt-2">
            <Suspense fallback={null}>
              <SkillDiscoverSection onRemove={(id) => {
                const skill = skills.find((item) => item.id === id);
                if (skill) void actions.removeOne(skill);
              }} />
            </Suspense>
          </div>
        </div>
      </div>

      {current && (
        <SkillDetailPanel
          target={current}
          sourceLabel={detailSource(current)}
          check={current.kind === "library" ? checks[current.skill.id] : undefined}
          busy={current.kind === "library" && actions.busyIds.has(current.skill.id)}
          onClose={() => setSelected(null)}
          onUpdate={actions.updateOne}
          onRemove={(skill) => void actions.removeOne(skill)}
        />
      )}

      {actions.editing && <UpdateEditedDialog skill={actions.editing} onKeep={actions.cancelEdited} onUpdate={actions.confirmEdited} />}
      {actions.gone && <RemoveGoneDialog skills={actions.gone} onCancel={actions.cancelGone} onConfirm={actions.confirmGone} />}
    </div>
  );
}
