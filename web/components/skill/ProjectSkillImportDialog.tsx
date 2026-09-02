// 导入技能到项目：四个来源（已装用户技能 / CLI 本机发现 / 技能市场 / 其他项目），
// 选目标根目录 + 可选改名 + 是否覆盖。真正的复制/下载由后端 import_project_skill 完成。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedTabs } from "@/components/ui/segmented";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { skillService } from "@/services/skillService";
import { useWorkspacesStore } from "@/stores";
import type {
  DiscoveredExternalSkill,
  InstalledUserSkill,
  ProjectSkill,
  ProjectSkillImportSource,
  ProjectSkillRoot,
  SkillMarketEntry,
  SkillScope,
} from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import { suggestSkillName, validateSkillName } from "./projectSkillModel";

type SourceKind = "user" | "external" | "market" | "project" | "workspace";

interface ProjectSkillImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: SkillScope;
  roots: ProjectSkillRoot[];
  defaultRoot: string;
  existingNames: ReadonlySet<string>;
  busy: boolean;
  onImport: (
    root: string,
    source: ProjectSkillImportSource,
    options: { name?: string; overwrite: boolean },
  ) => Promise<unknown>;
}

interface Candidate {
  key: string;
  name: string;
  description?: string | null;
  meta?: string;
  source: ProjectSkillImportSource;
}

export default function ProjectSkillImportDialog({
  open,
  onOpenChange,
  scope,
  roots,
  defaultRoot,
  existingNames,
  busy,
  onImport,
}: ProjectSkillImportDialogProps) {
  const { t } = useTranslation("projectSkills");
  const isWorkspaceScope = scope.kind === "workspace";
  const projectPath = scope.kind === "project" ? scope.projectPath : "";
  // 项目作用域默认先看工作空间技能（workspace-first）；工作空间作用域没有这个来源
  const [kind, setKind] = useState<SourceKind>(isWorkspaceScope ? "user" : "workspace");
  const [otherWorkspace, setOtherWorkspace] = useState<string>("");
  const [workspaceSkills, setWorkspaceSkills] = useState<ProjectSkill[]>([]);
  const [root, setRoot] = useState(defaultRoot);
  const [nameOverride, setNameOverride] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [userSkills, setUserSkills] = useState<InstalledUserSkill[]>([]);
  const [external, setExternal] = useState<DiscoveredExternalSkill[]>([]);
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState<SkillMarketEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [otherProject, setOtherProject] = useState<string>("");
  const [otherSkills, setOtherSkills] = useState<ProjectSkill[]>([]);
  const [importingKey, setImportingKey] = useState<string | null>(null);

  // selector 只取原数组引用；派生列表放 useMemo，避免每次返回新数组触发无限重渲染
  const workspaces = useWorkspacesStore((state) => state.workspaces);
  const otherProjects = useMemo(
    () =>
      workspaces
        .flatMap((workspace) => workspace.projects)
        .filter((project) => project.path !== projectPath),
    [workspaces, projectPath],
  );
  const workspaceOptions = useMemo(
    () =>
      workspaces.filter(
        (workspace) => !(scope.kind === "workspace" && workspace.name === scope.workspaceName),
      ),
    [workspaces, scope],
  );
  // 项目作用域：默认选中包含该项目的工作空间
  const owningWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.projects.some((project) => project.path === projectPath))?.name ?? "",
    [workspaces, projectPath],
  );

  useEffect(() => {
    if (!open) return;
    setRoot(defaultRoot);
    setNameOverride("");
    setOtherWorkspace(owningWorkspace);
    skillService.listUserSkills().then(setUserSkills).catch((e) => handleErrorSilent(e, "list user skills"));
    skillService
      .listExternalSkills()
      .then((list) => setExternal(list.filter((skill) => skill.path.replace(/\\/g, "/").endsWith("/SKILL.md"))))
      .catch((e) => handleErrorSilent(e, "list external skills"));
  }, [open, defaultRoot, owningWorkspace]);

  useEffect(() => {
    if (!open || kind !== "workspace" || !otherWorkspace) {
      setWorkspaceSkills([]);
      return;
    }
    skillService
      .listWorkspaceSkills(otherWorkspace)
      .then(setWorkspaceSkills)
      .catch((e) => handleErrorSilent(e, "list workspace skills"));
  }, [open, kind, otherWorkspace]);

  // 市场：空串取目录，否则防抖搜索
  useEffect(() => {
    if (!open || kind !== "market") return;
    setSearching(true);
    const timer = window.setTimeout(() => {
      const request = query.trim()
        ? skillService.searchSkillMarket(query.trim())
        : skillService.listSkillMarketEntries();
      request
        .then(setMarket)
        .catch((e) => handleErrorSilent(e, "search skill market"))
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, kind, query]);

  useEffect(() => {
    if (!open || kind !== "project" || !otherProject) {
      setOtherSkills([]);
      return;
    }
    skillService.listProjectSkills(otherProject).then(setOtherSkills).catch((e) => handleErrorSilent(e, "list other project skills"));
  }, [open, kind, otherProject]);

  const candidates: Candidate[] = useMemo(() => {
    switch (kind) {
      case "user":
        return userSkills.map((skill) => ({
          key: `user:${skill.id}`,
          name: skill.id,
          description: skill.description,
          meta: skill.version,
          source: { kind: "user", id: skill.id },
        }));
      case "external":
        return external.map((skill) => ({
          key: `external:${skill.id}`,
          name: skill.name,
          description: skill.description,
          meta: skill.id,
          source: { kind: "external", id: skill.id },
        }));
      case "market":
        return market
          .filter((entry) => entry.repo)
          .map((entry) => ({
            key: `market:${entry.id}`,
            name: entry.name,
            description: entry.description,
            meta: entry.repo ?? undefined,
            source: { kind: "market", entry },
          }));
      case "project":
        return otherSkills.map((skill) => ({
          key: `project:${skill.id}`,
          name: skill.name,
          description: skill.description,
          meta: `${skill.root}/${skill.relDir}`,
          source: { kind: "project", projectPath: otherProject, root: skill.root, relDir: skill.relDir },
        }));
      case "workspace":
        return workspaceSkills.map((skill) => ({
          key: `workspace:${otherWorkspace}:${skill.id}`,
          name: skill.name,
          description: skill.description,
          meta: otherWorkspace,
          source: { kind: "workspace", workspaceName: otherWorkspace, relDir: skill.relDir },
        }));
      default:
        return [];
    }
  }, [kind, userSkills, external, market, otherSkills, otherProject, workspaceSkills, otherWorkspace]);

  const EMPTY_KEYS: Record<SourceKind, string> = {
    user: "importDialog.noUserSkills",
    external: "importDialog.noExternalSkills",
    market: "importDialog.noMarketResults",
    project: "importDialog.noProjectSkills",
    workspace: "importDialog.noWorkspaceSkills",
  };
  const emptyKey = EMPTY_KEYS[kind];

  const sourceTabs = [
    ...(isWorkspaceScope ? [] : [{ value: "workspace" as SourceKind, label: t("importDialog.sourceWorkspace") }]),
    { value: "user" as SourceKind, label: t("importDialog.sourceUser") },
    { value: "external" as SourceKind, label: t("importDialog.sourceExternal") },
    { value: "market" as SourceKind, label: t("importDialog.sourceMarket") },
    { value: "project" as SourceKind, label: t("importDialog.sourceProject") },
  ];

  const overrideState = nameOverride.trim() ? validateSkillName(nameOverride) : "ok";

  const targetNameFor = (candidate: Candidate) =>
    nameOverride.trim() || suggestSkillName(candidate.name) || candidate.name;

  const handleImport = async (candidate: Candidate) => {
    if (overrideState !== "ok") return;
    setImportingKey(candidate.key);
    try {
      const name = targetNameFor(candidate);
      const result = await onImport(root, candidate.source, { name, overwrite });
      if (result) onOpenChange(false);
    } finally {
      setImportingKey(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[720px] max-w-[92vw] flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{t("importDialog.title")}</DialogTitle>
          <DialogDescription>{t("importDialog.description")}</DialogDescription>
        </DialogHeader>

        <div className={`grid gap-3 ${isWorkspaceScope ? "grid-cols-1" : "grid-cols-2"}`}>
          {!isWorkspaceScope && (
          <div className="space-y-1">
            <Label className="text-xs">{t("importDialog.targetRoot")}</Label>
            <Select value={root} onValueChange={setRoot}>
              <SelectTrigger className="h-8 text-xs" aria-label={t("importDialog.targetRoot")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roots.map((candidate) => (
                  <SelectItem key={candidate.root} value={candidate.root} className="text-xs">
                    <span className="font-mono">{candidate.root}</span>
                    <span className="ml-2" style={{ color: "var(--app-text-tertiary)" }}>
                      {candidate.consumers.map((id) => t(`consumer.${id}` as never)).join(" · ")}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">{t("importDialog.nameOverride")}</Label>
            <Input
              value={nameOverride}
              onChange={(event) => setNameOverride(event.target.value)}
              placeholder={t("editor.namePlaceholder")}
              className="h-8 font-mono text-xs"
              aria-invalid={overrideState === "invalid"}
            />
          </div>
        </div>
        <CheckboxRow checked={overwrite} onCheckedChange={setOverwrite} label={t("importDialog.overwrite")} />

        <SegmentedTabs<SourceKind> size="sm" value={kind} onValueChange={setKind} items={sourceTabs} />

        {kind === "workspace" && (
          <Select value={otherWorkspace} onValueChange={setOtherWorkspace}>
            <SelectTrigger className="h-8 text-xs" aria-label={t("importDialog.sourceWorkspace")}>
              <SelectValue placeholder={t("importDialog.sourceWorkspace")} />
            </SelectTrigger>
            <SelectContent>
              {workspaceOptions.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.name} className="text-xs">
                  {workspace.alias || workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {kind === "market" && (
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("importDialog.searchMarket")}
            className="h-8 text-xs"
          />
        )}
        {kind === "project" && (
          <Select value={otherProject} onValueChange={setOtherProject}>
            <SelectTrigger className="h-8 text-xs" aria-label={t("importDialog.sourceProject")}>
              <SelectValue placeholder={t("importDialog.sourceProject")} />
            </SelectTrigger>
            <SelectContent>
              {otherProjects.map((project) => (
                <SelectItem key={project.id} value={project.path} className="text-xs">
                  {project.alias || project.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
          {searching && kind === "market" ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              <Loader2 size={14} className="animate-spin" />
              {t("importDialog.searching")}
            </div>
          ) : candidates.length === 0 ? (
            <div className="py-8 text-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {t(emptyKey as never)}
            </div>
          ) : (
            candidates.map((candidate) => {
              const target = targetNameFor(candidate);
              const exists = existingNames.has(`${isWorkspaceScope ? "workspace" : root}::${target}`);
              const importing = importingKey === candidate.key;
              return (
                <div key={candidate.key} className="flex items-center gap-3 border-b border-border/50 px-3 py-2 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs font-medium">{candidate.name}</span>
                      {exists && (
                        <span className="rounded-full px-1.5 text-[10px]" style={{ background: "var(--app-status-warning-bg)", color: "var(--app-status-warning)" }}>
                          {t("importDialog.exists")}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px]" style={{ color: "var(--app-text-tertiary)" }} title={candidate.description ?? undefined}>
                      {candidate.description || candidate.meta}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={exists ? "outline" : "default"}
                    className="h-7 px-2.5 text-xs"
                    disabled={busy || importing || (exists && !overwrite) || overrideState !== "ok"}
                    onClick={() => void handleImport(candidate)}
                  >
                    {importing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {importing ? t("importDialog.importing") : t("importDialog.importBtn")}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
