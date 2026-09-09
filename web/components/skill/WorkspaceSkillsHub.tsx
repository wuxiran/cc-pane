// 工作空间 Skill 有效集：和市场页一样用卡片平铺，点开再编辑。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2, Plus, RefreshCw, Search, Download } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DescriptionLangToggle } from "@/components/ui/DescriptionLangToggle";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { isBuiltinSkillSelected, toDraft } from "@/components/providers/launchProfileHelpers";
import { nextToggleBuiltinSkill } from "@/components/providers/launchProfileSkillPolicy";
import { iconGlyph, toneFor } from "@/components/skillmarket/skillMarketModel";
import { useDescriptionLang } from "@/hooks/useDescriptionLang";
import { skillService } from "@/services/skillService";
import { useLaunchProfilesStore } from "@/stores/useLaunchProfilesStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import type { BundledSkill, ProjectSkill, ProjectSkillContent, WorkspaceProjectSkill } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import ConsumerBadges from "./ConsumerBadges";
import ProjectSkillEditor from "./ProjectSkillEditor";
import ProjectSkillImportDialog from "./ProjectSkillImportDialog";
import RemoteRuntimeNotice from "@/components/providers/RemoteRuntimeNotice";
import { FALLBACK_ROOTS, WORKSPACE_VIRTUAL_ROOT } from "./projectSkillModel";
import { useProjectSkills } from "./useProjectSkills";
import {
  bundledPolicyName,
  filterBundledSkills,
  filterProjectSkills,
  filterWorkspaceSkills,
  groupProjectSkills,
  projectLabel,
  resolveWorkspaceLaunchProfile,
} from "./workspaceSkillHubModel";

type Selection =
  | { kind: "workspace"; id: string }
  | { kind: "bundled"; name: string }
  | { kind: "project"; projectPath: string; skillId: string }
  | { kind: "create" };

type SourceFilter = "all" | "workspace" | "bundled" | "project";

interface WorkspaceSkillsHubProps {
  workspaceName: string;
}

export default function WorkspaceSkillsHub({ workspaceName }: WorkspaceSkillsHubProps) {
  const { t } = useTranslation("projectSkills");
  const { describe } = useDescriptionLang();
  const model = useProjectSkills({ kind: "workspace", workspaceName });
  const workspace = useWorkspacesStore((s) => s.workspaces.find((item) => item.name === workspaceName));
  const profiles = useLaunchProfilesStore((s) => s.profiles);
  const loadProfiles = useLaunchProfilesStore((s) => s.load);
  const updateProfile = useLaunchProfilesStore((s) => s.update);

  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [creating, setCreating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [bundled, setBundled] = useState<BundledSkill[]>([]);
  const [projectSkills, setProjectSkills] = useState<WorkspaceProjectSkill[]>([]);
  const [projectRoots, setProjectRoots] = useState(FALLBACK_ROOTS);
  const [extraLoading, setExtraLoading] = useState(true);
  const [bundledContent, setBundledContent] = useState<ProjectSkillContent | null>(null);
  const [projectContent, setProjectContent] = useState<ProjectSkillContent | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);

  const profile = useMemo(
    () => resolveWorkspaceLaunchProfile(workspace, profiles),
    [workspace, profiles],
  );

  const reloadExtra = useCallback(async () => {
    setExtraLoading(true);
    try {
      const [nextBundled, nextProjects, roots] = await Promise.all([
        skillService.listBundledSkills().catch((error) => {
          handleErrorSilent(error, "list bundled skills");
          return [] as BundledSkill[];
        }),
        skillService.listWorkspaceProjectSkills(workspaceName).catch((error) => {
          handleErrorSilent(error, "list workspace project skills");
          return [] as WorkspaceProjectSkill[];
        }),
        skillService.listProjectSkillRoots().catch((error) => {
          handleErrorSilent(error, "list project skill roots");
          return [] as typeof FALLBACK_ROOTS;
        }),
      ]);
      setBundled(nextBundled);
      setProjectSkills(nextProjects);
      if (roots.length > 0) setProjectRoots(roots);
    } finally {
      setExtraLoading(false);
    }
  }, [workspaceName]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    void reloadExtra();
  }, [reloadExtra]);

  const visibleWorkspace = useMemo(
    () => filterWorkspaceSkills(model.skills, query),
    [model.skills, query],
  );
  const visibleBundled = useMemo(() => filterBundledSkills(bundled, query), [bundled, query]);
  const visibleProjects = useMemo(
    () => filterProjectSkills(projectSkills, query),
    [projectSkills, query],
  );
  const projectGroups = useMemo(() => groupProjectSkills(visibleProjects), [visibleProjects]);
  const existingIds = useMemo(() => new Set(model.skills.map((skill) => skill.id)), [model.skills]);
  const selectedBundled = selection?.kind === "bundled"
    ? bundled.find((skill) => skill.name === selection.name) ?? null
    : null;

  useEffect(() => {
    if (selection?.kind !== "bundled") {
      setBundledContent(null);
      return;
    }
    let cancelled = false;
    skillService
      .readBundledSkill(selection.name)
      .then((content) => {
        if (!cancelled) setBundledContent(content);
      })
      .catch((error) => handleErrorSilent(error, "read bundled skill"));
    return () => {
      cancelled = true;
    };
  }, [selection]);

  useEffect(() => {
    if (selection?.kind !== "project") {
      setProjectContent(null);
      return;
    }
    const item = projectSkills.find(
      (entry) => entry.projectPath === selection.projectPath && entry.skill.id === selection.skillId,
    );
    if (!item) {
      setProjectContent(null);
      return;
    }
    let cancelled = false;
    skillService
      .readProjectSkill(item.projectPath, item.skill.root, item.skill.relDir)
      .then((content) => {
        if (!cancelled) setProjectContent(content);
      })
      .catch((error) => handleErrorSilent(error, "read project skill"));
    return () => {
      cancelled = true;
    };
  }, [selection, projectSkills]);

  const reloadAll = async () => {
    await Promise.all([model.reload(), reloadExtra()]);
  };

  const closeDetail = () => {
    setCreating(false);
    setSelection(null);
    model.select(null);
  };

  const startCreate = () => {
    model.select(null);
    setCreating(true);
    setSelection({ kind: "create" });
  };

  const selectWorkspace = (skill: ProjectSkill) => {
    setCreating(false);
    setSelection({ kind: "workspace", id: skill.id });
    model.select(skill.id);
  };

  const selectBundled = (skill: BundledSkill) => {
    setCreating(false);
    model.select(null);
    setSelection({ kind: "bundled", name: skill.name });
  };

  const selectProject = (item: WorkspaceProjectSkill) => {
    setCreating(false);
    model.select(null);
    setSelection({ kind: "project", projectPath: item.projectPath, skillId: item.skill.id });
  };

  const toggleBuiltin = async (name: string) => {
    if (!profile) {
      toast.error(t("hub.noProfile"));
      return;
    }
    try {
      await updateProfile(profile.id, nextToggleBuiltinSkill(toDraft(profile), bundledPolicyName(name)));
    } catch (error) {
      toast.error(t("toast.failed", { error: String(error) }));
    }
  };

  const copyBundled = async (name: string) => {
    const imported = await model.importSkill("workspace", { kind: "bundled", name }, { overwrite: false });
    if (imported) {
      setCreating(false);
      setSelection({ kind: "workspace", id: imported.id });
    }
  };

  const saveProject = async (root: string, name: string, content: string) => {
    if (selection?.kind !== "project") return;
    setProjectBusy(true);
    try {
      const saved = await skillService.saveProjectSkill(selection.projectPath, root, name, content);
      toast.success(t("toast.saved", { name: saved.name }));
      await reloadExtra();
      setSelection({ kind: "project", projectPath: selection.projectPath, skillId: saved.id });
    } catch (error) {
      toast.error(t("toast.failed", { error: String(error) }));
    } finally {
      setProjectBusy(false);
    }
  };

  const deleteProject = async (content: ProjectSkillContent) => {
    if (selection?.kind !== "project") return;
    setProjectBusy(true);
    try {
      await skillService.deleteProjectSkill(selection.projectPath, content.skill.root, content.skill.relDir);
      toast.success(t("toast.deleted", { name: content.skill.name }));
      closeDetail();
      await reloadExtra();
    } catch (error) {
      toast.error(t("toast.failed", { error: String(error) }));
    } finally {
      setProjectBusy(false);
    }
  };

  const moveProject = async (content: ProjectSkillContent, toRoot: string) => {
    if (selection?.kind !== "project") return;
    setProjectBusy(true);
    try {
      const moved = await skillService.moveProjectSkill(
        selection.projectPath,
        content.skill.root,
        content.skill.relDir,
        toRoot,
      );
      toast.success(t("toast.moved", { name: moved.name, root: toRoot }));
      await reloadExtra();
      setSelection({ kind: "project", projectPath: selection.projectPath, skillId: moved.id });
    } catch (error) {
      toast.error(t("toast.failed", { error: String(error) }));
    } finally {
      setProjectBusy(false);
    }
  };

  const showEditor = creating || selection !== null;
  const loading = model.loading || extraLoading;
  const builtinEnabled = (name: string) =>
    profile ? isBuiltinSkillSelected(profile.skillPolicy, bundledPolicyName(name)) : false;
  const showWorkspace = sourceFilter === "all" || sourceFilter === "workspace";
  const showBundled = sourceFilter === "all" || sourceFilter === "bundled";
  const showProject = sourceFilter === "all" || sourceFilter === "project";

  return (
    <div className="flex h-full flex-col" data-testid="workspace-skills-hub">
      <header className="shrink-0 px-6 pb-3 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
              {t("workspaceTitle")}
            </h1>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--app-text-tertiary)" }}>
              {t("hub.summary", {
                workspace: model.skills.length,
                bundled: bundled.length,
                project: projectSkills.length,
              })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <DescriptionLangToggle className="mr-1" />
            <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => void reloadAll()} disabled={loading} aria-label={t("refresh")}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </Button>
            <Button size="sm" variant="outline" className="h-8" onClick={() => setImportOpen(true)}>
              <Download size={13} className="mr-1.5" />
              {t("import")}
            </Button>
            <Button size="sm" className="h-8" onClick={startCreate}>
              <Plus size={13} className="mr-1.5" />
              {t("newSkill")}
            </Button>
          </div>
        </div>
        <div className="relative mt-4 max-w-xl">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--app-text-tertiary)" }} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("hub.searchPlaceholder")}
            className="h-9 pl-9 text-sm"
            aria-label={t("hub.searchPlaceholder")}
          />
        </div>
      </header>

      {showEditor && creating ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ProjectSkillEditor
            roots={[WORKSPACE_VIRTUAL_ROOT]}
            singleRoot
            existing={null}
            defaultRoot={WORKSPACE_VIRTUAL_ROOT.root}
            busy={model.busy}
            onSave={(_root, name, content) => {
              void model.save("workspace", name, content).then((saved) => {
                if (saved) {
                  setCreating(false);
                  setSelection({ kind: "workspace", id: saved.id });
                }
              });
            }}
            onCancel={closeDetail}
            onDelete={() => undefined}
            onMove={() => undefined}
          />
        </div>
      ) : showEditor && selection?.kind === "workspace" && model.selected ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ProjectSkillEditor
            roots={[WORKSPACE_VIRTUAL_ROOT]}
            singleRoot
            existing={model.selected}
            defaultRoot={WORKSPACE_VIRTUAL_ROOT.root}
            busy={model.busy}
            onSave={(_root, name, content) => void model.save("workspace", name, content)}
            onCancel={closeDetail}
            onDelete={(content) => {
              void model.remove(content.skill).then(closeDetail);
            }}
            onMove={() => undefined}
          />
        </div>
      ) : showEditor && selection?.kind === "bundled" && selectedBundled ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <BundledDetail
            skill={selectedBundled}
            description={describe(selectedBundled.descriptions, selectedBundled.description)}
            content={bundledContent}
            enabled={builtinEnabled(selectedBundled.name)}
            profileName={profile?.alias || profile?.name}
            busy={model.busy}
            onCopy={() => void copyBundled(selectedBundled.name)}
            onToggle={() => void toggleBuiltin(selectedBundled.name)}
            canToggle={Boolean(profile)}
            onBack={closeDetail}
          />
        </div>
      ) : showEditor && selection?.kind === "project" && projectContent ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ProjectSkillEditor
            roots={projectRoots}
            existing={projectContent}
            defaultRoot={projectContent.skill.root}
            busy={projectBusy}
            onSave={saveProject}
            onCancel={closeDetail}
            onDelete={deleteProject}
            onMove={moveProject}
          />
        </div>
      ) : (
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <RemoteRuntimeNotice workspace={workspace} profile={profile} subject="skills" className="mb-4" />
          <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label={t("workspaceTitle")}>
            <FilterChip active={sourceFilter === "all"} label={t("hub.filterAll")} onClick={() => setSourceFilter("all")} />
            <FilterChip
              active={sourceFilter === "workspace"}
              label={`${t("hub.workspaceSection")} ${model.skills.length}`}
              onClick={() => setSourceFilter("workspace")}
            />
            <FilterChip
              active={sourceFilter === "bundled"}
              label={`${t("hub.builtinSection")} ${bundled.length}`}
              onClick={() => setSourceFilter("bundled")}
            />
            <FilterChip
              active={sourceFilter === "project"}
              label={`${t("hub.projectSection")} ${projectSkills.length}`}
              onClick={() => setSourceFilter("project")}
            />
          </div>

          {loading && model.skills.length === 0 && bundled.length === 0 && projectSkills.length === 0 ? (
            <LoadingGrid />
          ) : (
            <>
              {showWorkspace && (visibleWorkspace.length > 0 || !query) && (
                <CardSection title={t("hub.workspaceSection")} count={model.skills.length}>
                  {visibleWorkspace.length === 0 ? (
                    <button
                      type="button"
                      onClick={startCreate}
                      className="flex min-h-[128px] flex-col items-start justify-center gap-1 rounded-xl border border-dashed px-4 text-left"
                      style={{ borderColor: "var(--app-home-border)", color: "var(--app-text-tertiary)" }}
                    >
                      <span className="text-[13px] font-medium" style={{ color: "var(--app-text-secondary)" }}>
                        {t("hub.workspaceEmpty")}
                      </span>
                      <span className="text-[12px]">{t("hub.selectWorkspace")}</span>
                    </button>
                  ) : visibleWorkspace.map((skill) => (
                    <SkillCard
                      key={skill.id}
                      name={skill.name}
                      description={skill.description}
                      badge={t("hub.sourceWorkspace")}
                      consumers={skill.consumers}
                      onClick={() => selectWorkspace(skill)}
                    />
                  ))}
                </CardSection>
              )}

              {showBundled && visibleBundled.length > 0 && (
                <CardSection title={t("hub.builtinSection")} count={bundled.length}>
                  {visibleBundled.map((skill) => (
                    <SkillCard
                      key={skill.name}
                      name={skill.name}
                      description={describe(skill.descriptions, skill.description)}
                      badge={t("hub.sourceBuiltin")}
                      consumers={["claude", "codex"]}
                      onClick={() => selectBundled(skill)}
                      trailing={
                        <Switch
                          checked={builtinEnabled(skill.name)}
                          disabled={!profile}
                          onClick={(event) => event.stopPropagation()}
                          onCheckedChange={() => void toggleBuiltin(skill.name)}
                          aria-label={`${t("hub.enabled")} ${skill.name}`}
                        />
                      }
                    />
                  ))}
                </CardSection>
              )}

              {showProject && (projectGroups.length > 0 || (!query && sourceFilter === "project")) && (
                <CardSection title={t("hub.projectSection")} count={projectSkills.length}>
                  {projectGroups.length === 0 ? (
                    <p className="col-span-full py-6 text-[13px]" style={{ color: "var(--app-text-tertiary)" }}>
                      {t("hub.projectEmpty")}
                    </p>
                  ) : projectGroups.flatMap((group) =>
                    group.skills.map((item) => (
                      <SkillCard
                        key={`${item.projectPath}::${item.skill.id}`}
                        name={item.skill.name}
                        description={item.skill.description}
                        badge={projectLabel(item)}
                        meta={item.skill.root}
                        consumers={item.skill.consumers}
                        onClick={() => selectProject(item)}
                      />
                    )),
                  )}
                </CardSection>
              )}
            </>
          )}
        </div>
      )}

      <ProjectSkillImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        scope={{ kind: "workspace", workspaceName }}
        roots={[WORKSPACE_VIRTUAL_ROOT]}
        defaultRoot={WORKSPACE_VIRTUAL_ROOT.root}
        existingNames={existingIds}
        busy={model.busy}
        onImport={(_root, source, options) => model.importSkill("workspace", source, options)}
      />
    </div>
  );
}

function CardSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="mb-6" aria-label={title}>
      <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--app-text-primary)" }}>
        {title}
        <span className="ml-2 text-xs font-normal" style={{ color: "var(--app-text-tertiary)" }}>{count}</span>
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
        {children}
      </div>
    </section>
  );
}

function FilterChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="rounded-full px-3 py-1 text-xs transition-colors"
      style={
        active
          ? {
              background: "color-mix(in srgb, var(--app-accent) 16%, transparent)",
              color: "var(--app-accent)",
            }
          : {
              background: "color-mix(in srgb, var(--app-text-primary) 5%, transparent)",
              color: "var(--app-text-secondary)",
            }
      }
    >
      {label}
    </button>
  );
}

function SkillCard({
  name,
  description,
  badge,
  meta,
  consumers,
  trailing,
  onClick,
}: {
  name: string;
  description?: string | null;
  badge: string;
  meta?: string;
  consumers: readonly string[];
  trailing?: ReactNode;
  onClick: () => void;
}) {
  const tone = toneFor(name);
  const glyph = iconGlyph(name.replace(/^ccpanes-/, ""));
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      className="group flex min-h-[128px] cursor-pointer flex-col gap-2.5 rounded-xl border p-3.5 text-left transition-colors hover:border-[var(--app-home-border-hover)]"
      style={{
        background: "var(--app-home-surface)",
        borderColor: "var(--app-home-border)",
      }}
      data-testid="workspace-skill-card"
      data-skill-id={name}
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
          {glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }} title={name}>
            {name}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            <span className="truncate">{badge}</span>
            {meta && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate font-mono">{meta}</span>
              </>
            )}
          </div>
        </div>
        {trailing && <div className="shrink-0" onClick={(event) => event.stopPropagation()}>{trailing}</div>}
      </div>
      <p
        className="line-clamp-2 flex-1 text-xs leading-relaxed"
        style={{ color: description ? "var(--app-text-secondary)" : "var(--app-text-tertiary)" }}
        title={description ?? undefined}
      >
        {description || " "}
      </p>
      <ConsumerBadges consumers={consumers} compact />
    </div>
  );
}

function BundledDetail({
  skill,
  description,
  content,
  enabled,
  profileName,
  busy,
  canToggle,
  onCopy,
  onToggle,
  onBack,
}: {
  skill: BundledSkill;
  description: string | null;
  content: ProjectSkillContent | null;
  enabled: boolean;
  profileName?: string;
  busy: boolean;
  canToggle: boolean;
  onCopy: () => void;
  onToggle: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation("projectSkills");
  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold" style={{ color: "var(--app-text-primary)" }}>
                {skill.name}
              </h2>
              <Badge variant="secondary" className="text-[10px]">{t("hub.sourceBuiltin")}</Badge>
              <ConsumerBadges consumers={["claude", "codex"]} />
            </div>
            {description && (
              <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed" style={{ color: "var(--app-text-secondary)" }}>
                {description}
              </p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--app-text-tertiary)" }}>
              {profileName ? t("hub.profileLabel", { name: profileName }) : t("hub.noProfile")}
              {" · "}
              {t("hub.readonlyHint")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--app-text-secondary)" }}>
              <span>{t("hub.enabled")}</span>
              <Switch checked={enabled} disabled={!canToggle} onCheckedChange={onToggle} aria-label={skill.name} />
            </label>
            <Button size="sm" onClick={onCopy} disabled={busy}>
              <Copy size={13} className="mr-1.5" />
              {t("hub.copyToWorkspace")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onBack}>{t("editor.cancel")}</Button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        {content ? (
          <textarea
            value={content.content}
            readOnly
            className="h-full min-h-[280px] w-full resize-none rounded-lg border border-border p-4 font-mono text-[13px] leading-relaxed focus:outline-none"
            style={{ background: "color-mix(in srgb, var(--app-text-primary) 3%, transparent)", color: "var(--app-text-primary)" }}
            aria-label="SKILL.md"
            spellCheck={false}
          />
        ) : (
          <div
            className="rounded-lg border border-dashed border-border px-5 py-8 text-[13px] leading-relaxed"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            {t("hub.builtinMountNote")}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3" aria-busy="true">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-[128px] rounded-xl" />
      ))}
      <span className="sr-only">
        <Loader2 className="animate-spin" />
      </span>
    </div>
  );
}
