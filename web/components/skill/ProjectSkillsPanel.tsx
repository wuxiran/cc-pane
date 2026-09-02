// Agent Skills 面板（项目 / 工作空间两种作用域共用）：左侧按根目录分组的技能列表
// （带 CLI 可见性徽章），右侧编辑器；顶部新建 / 导入 / 刷新。
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderGit2, Layers, Loader2, Plus, RefreshCw, Sparkles, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { ProjectSkill, SkillScope } from "@/types";
import ConsumerBadges from "./ConsumerBadges";
import ProjectSkillEditor from "./ProjectSkillEditor";
import ProjectSkillImportDialog from "./ProjectSkillImportDialog";
import { defaultRoot, groupByRoot } from "./projectSkillModel";
import { useProjectSkills } from "./useProjectSkills";

interface ProjectSkillsPanelProps {
  scope: SkillScope;
}

export default function ProjectSkillsPanel({ scope }: ProjectSkillsPanelProps) {
  const { t } = useTranslation("projectSkills");
  const model = useProjectSkills(scope);
  const [creating, setCreating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const isWorkspace = scope.kind === "workspace";

  const groups = useMemo(() => groupByRoot(model.skills, model.roots), [model.skills, model.roots]);
  const preferredRoot = useMemo(() => defaultRoot(model.roots), [model.roots]);
  const existingIds = useMemo(() => new Set(model.skills.map((skill) => skill.id)), [model.skills]);

  const startCreate = () => {
    model.select(null);
    setCreating(true);
  };
  const selectSkill = (skill: ProjectSkill) => {
    setCreating(false);
    model.select(skill.id);
  };
  const showEditor = creating || model.selected !== null;
  const TitleIcon = isWorkspace ? Layers : FolderGit2;

  return (
    <div className="flex h-full" data-testid="project-skills-panel" data-scope={scope.kind}>
      <div className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-2">
            <TitleIcon size={16} className="text-muted-foreground" />
            <span className="text-sm font-medium">{isWorkspace ? t("workspaceTitle") : t("title")}</span>
            <Badge variant="secondary" className="text-xs">{model.skills.length}</Badge>
          </div>
          <div className="flex items-center gap-0.5">
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void model.reload()} title={t("refresh")} aria-label={t("refresh")} disabled={model.loading}>
              <RefreshCw size={13} className={model.loading ? "animate-spin" : ""} />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setImportOpen(true)} title={t("import")} aria-label={t("import")}>
              <Download size={14} />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={startCreate} title={t("newSkill")} aria-label={t("newSkill")}>
              <Plus size={14} />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {model.loading && model.skills.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
              <span>{t("refresh")}</span>
            </div>
          )}
          {!model.loading && model.skills.length === 0 && (
            <EmptyState
              icon={Sparkles}
              title={isWorkspace ? t("workspaceEmpty.title") : t("empty.title")}
              description={isWorkspace ? t("workspaceEmpty.hint") : t("empty.hint")}
              action={{ label: t("import"), onClick: () => setImportOpen(true) }}
            />
          )}
          {groups.map((group) => (
            <section key={group.root.root} aria-label={group.root.root}>
              <div className="flex items-center justify-between px-3 pb-1 pt-3">
                <span className="truncate font-mono text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                  {isWorkspace ? t("workspaceRootLabel") : group.root.root}
                </span>
                <ConsumerBadges consumers={group.root.consumers} compact />
              </div>
              {group.skills.map((skill) => {
                const active = model.selectedId === skill.id && !creating;
                return (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => selectSkill(skill)}
                    className={`flex w-full items-start gap-2 border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-accent/50 ${active ? "bg-accent" : ""}`}
                    data-skill-id={skill.id}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-mono text-sm">{skill.name}</span>
                        {skill.hasScripts && (
                          <span className="shrink-0 rounded px-1 text-[10px]" style={{ background: "color-mix(in srgb, var(--app-text-primary) 6%, transparent)", color: "var(--app-text-tertiary)" }}>
                            {t("hasScripts")}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground" title={skill.description ?? undefined}>
                        {skill.description || t("files", { count: skill.fileCount })}
                      </div>
                    </div>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-hidden">
        {showEditor ? (
          <ProjectSkillEditor
            roots={model.roots}
            singleRoot={isWorkspace}
            existing={creating ? null : model.selected}
            defaultRoot={preferredRoot}
            busy={model.busy}
            onSave={(root, name, content) => {
              void model.save(root, name, content).then((saved) => {
                if (saved) setCreating(false);
              });
            }}
            onCancel={() => {
              setCreating(false);
              model.select(null);
            }}
            onDelete={(content) => void model.remove(content.skill)}
            onMove={(content, toRoot) => void model.move(content.skill, toRoot)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <div className="max-w-sm text-center">
              <Sparkles size={32} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("selectHint")}</p>
              <p className="mt-1 text-xs text-muted-foreground/60">{isWorkspace ? t("workspaceSubtitle") : t("subtitle")}</p>
            </div>
          </div>
        )}
      </div>

      <ProjectSkillImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        scope={scope}
        roots={model.roots}
        defaultRoot={preferredRoot}
        existingNames={existingIds}
        busy={model.busy}
        onImport={(root, source, options) => model.importSkill(root, source, options)}
      />
    </div>
  );
}
