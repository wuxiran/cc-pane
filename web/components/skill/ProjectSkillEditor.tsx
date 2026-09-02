// 项目技能编辑器：新建（选目录 + 起名）或编辑已有 SKILL.md；右侧列出目录文件。
// 编辑态提供移动到其他根目录 / 打开目录 / 删除。Ctrl+S 保存。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, FolderOpen, FolderInput, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { providerService } from "@/services/providerService";
import type { ProjectSkillContent, ProjectSkillRoot } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";
import ConsumerBadges from "./ConsumerBadges";
import { moveTargets, validateSkillName } from "./projectSkillModel";

interface ProjectSkillEditorProps {
  roots: ProjectSkillRoot[];
  /** 工作空间作用域：只有一个目录，不显示目录选择与「移动到」 */
  singleRoot?: boolean;
  /** null = 新建 */
  existing: ProjectSkillContent | null;
  defaultRoot: string;
  busy: boolean;
  onSave: (root: string, name: string, content: string) => void;
  onCancel: () => void;
  onDelete: (content: ProjectSkillContent) => void;
  onMove: (content: ProjectSkillContent, toRoot: string) => void;
}

export default function ProjectSkillEditor({
  roots,
  singleRoot = false,
  existing,
  defaultRoot,
  busy,
  onSave,
  onCancel,
  onDelete,
  onMove,
}: ProjectSkillEditorProps) {
  const { t } = useTranslation("projectSkills");
  const isNew = existing === null;
  const [root, setRoot] = useState(existing?.skill.root ?? defaultRoot);
  const [name, setName] = useState(existing?.skill.relDir ?? "");
  const [content, setContent] = useState(existing?.content ?? "");

  useEffect(() => {
    setRoot(existing?.skill.root ?? defaultRoot);
    setName(existing?.skill.relDir ?? "");
    setContent(existing?.content ?? "");
  }, [existing, defaultRoot]);

  const nameState = validateSkillName(name);
  const canSave = !busy && (isNew ? nameState === "ok" : true);
  const dirty = isNew ? name.trim().length > 0 || content.length > 0 : content !== existing.content;

  const handleSave = useCallback(() => {
    if (!canSave) return;
    onSave(root, isNew ? name.trim() : existing.skill.relDir, content);
  }, [canSave, onSave, root, isNew, name, existing, content]);

  useEffect(() => {
    function onKeydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        handleSave();
      }
    }
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [handleSave]);

  const targets = useMemo(() => (existing ? moveTargets(existing.skill, roots) : []), [existing, roots]);

  const openFolder = () => {
    if (!existing) return;
    providerService
      .openPathInExplorer(existing.skill.dirPath)
      .catch((error) => handleErrorSilent(error, "open skill folder"));
  };

  const confirmDelete = () => {
    if (!existing) return;
    if (window.confirm(t("editor.deleteConfirm", { name: existing.skill.name }))) onDelete(existing);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 border-b border-border px-4 py-2.5">
        {isNew ? (
          <div className="flex flex-1 flex-wrap items-end gap-3">
            {!singleRoot && (
            <div className="min-w-[200px] space-y-1">
              <Label className="text-xs">{t("root.label")}</Label>
              <Select value={root} onValueChange={setRoot}>
                <SelectTrigger className="h-8 text-xs" aria-label={t("root.label")}>
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
            <div className="min-w-[220px] flex-1 space-y-1">
              <Label className="text-xs">{t("editor.name")}</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("editor.namePlaceholder")}
                className="h-8 font-mono text-sm"
                aria-invalid={nameState === "invalid"}
              />
              {nameState === "invalid" && (
                <p className="text-[11px]" style={{ color: "var(--app-status-danger)" }}>
                  {t("editor.nameInvalid")}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-sm font-medium">{existing.skill.name}</span>
              <ConsumerBadges consumers={existing.skill.consumers} />
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px]" style={{ color: "var(--app-text-tertiary)" }} title={existing.skill.dirPath}>
              {singleRoot ? existing.skill.dirPath : `${existing.skill.root}/${existing.skill.relDir}`}
            </div>
          </div>
        )}
        <div className="flex shrink-0 items-center gap-1">
          {!isNew && (
            <>
              {!singleRoot && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" disabled={busy || targets.length === 0}>
                    <FolderInput size={14} className="mr-1" />
                    {t("editor.moveTo")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {targets.map((target) => (
                    <DropdownMenuItem key={target.root} className="font-mono text-xs" onClick={() => onMove(existing, target.root)}>
                      {target.root}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              )}
              <Button size="sm" variant="ghost" onClick={openFolder} title={t("editor.openFolder")} aria-label={t("editor.openFolder")}>
                <FolderOpen size={14} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={confirmDelete}
                disabled={busy}
                title={t("editor.delete")}
                aria-label={t("editor.delete")}
              >
                <Trash2 size={14} />
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <X size={14} className="mr-1" />
            {t("editor.cancel")}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave || (!isNew && !dirty)}>
            <Save size={14} className="mr-1" />
            {t("editor.save")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          className="h-full min-w-0 flex-1 resize-none border-none bg-background p-4 font-mono text-sm focus:outline-none"
          placeholder={t("editor.contentPlaceholder")}
          spellCheck={false}
          aria-label="SKILL.md"
        />
        {!isNew && existing.files.length > 1 && (
          <aside className="w-56 shrink-0 overflow-y-auto border-l border-border p-3">
            <div className="mb-2 text-[11px] font-medium" style={{ color: "var(--app-text-secondary)" }}>
              {t("editor.filesTitle")}
            </div>
            <ul className="space-y-1">
              {existing.files.map((file) => (
                <li key={file} className="flex items-center gap-1.5 truncate font-mono text-[11px]" style={{ color: "var(--app-text-tertiary)" }} title={file}>
                  <FileText size={11} className="shrink-0" />
                  <span className="truncate">{file}</span>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
}
