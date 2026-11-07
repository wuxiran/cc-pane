// 技能页右侧详情：只读的 SKILL.md、文件列表和来源；资源库技能另有更新、删除、打开文件夹。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle, ExternalLink, FolderOpen, Loader2, Trash2, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { skillLibraryService } from "@/services/skillLibraryService";
import { skillService } from "@/services/skillService";
import type { DiscoveredExternalSkill, ProjectSkill } from "@/types";
import type { LibrarySkill, SkillCheck } from "@/types/skillLibrary";
import { translateError } from "@/utils";
import { handleErrorSilent } from "@/utils/errorHandler";
import { openExternalUrl } from "./libraryChrome";
import { isGone, isTracked, skillSourceText } from "./skillLibraryModel";

export type SkillDetailTarget =
  | { kind: "library"; key: string; skill: LibrarySkill }
  | { kind: "builtin"; key: string; name: string; description: string | null }
  | { kind: "workspace"; key: string; workspaceName: string; skill: ProjectSkill }
  | { kind: "external"; key: string; skill: DiscoveredExternalSkill };

interface Content {
  content: string;
  files: string[];
  dirPath: string | null;
}

async function loadContent(target: SkillDetailTarget): Promise<Content | null> {
  switch (target.kind) {
    case "library": {
      const result = await skillLibraryService.read(target.skill.id);
      return { content: result.content, files: result.files, dirPath: result.dirPath };
    }
    case "builtin": {
      const result = await skillService.readBundledSkill(target.name);
      return result ? { content: result.content, files: result.files, dirPath: result.skill.dirPath } : null;
    }
    case "workspace": {
      const result = await skillService.readWorkspaceSkill(target.workspaceName, target.skill.relDir);
      return result ? { content: result.content, files: result.files, dirPath: result.skill.dirPath } : null;
    }
    case "external":
      // CLI 自带技能没有读取接口，只显示路径
      return null;
  }
}

function targetName(target: SkillDetailTarget): string {
  return target.kind === "builtin" ? target.name : target.skill.name;
}

interface SkillDetailPanelProps {
  target: SkillDetailTarget;
  sourceLabel: string;
  check?: SkillCheck;
  busy: boolean;
  onClose: () => void;
  onUpdate: (skill: LibrarySkill) => void;
  onRemove: (skill: LibrarySkill) => void;
}

export default function SkillDetailPanel({ target, sourceLabel, check, busy, onClose, onUpdate, onRemove }: SkillDetailPanelProps) {
  const { t } = useTranslation("settings");
  const [content, setContent] = useState<Content | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const name = targetName(target);
  const library = target.kind === "library" ? target.skill : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    loadContent(target)
      .then((result) => { if (!cancelled) setContent(result); })
      .catch((reason) => { if (!cancelled) setError(translateError(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // 只在换了一条时重读；同一条的列表刷新不必重读文件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.key]);

  const dirPath = content?.dirPath ?? library?.dirPath ?? (target.kind === "external" ? target.skill.path : null);
  const description = library?.description ?? (target.kind === "builtin" ? target.description : target.skill.description) ?? null;
  const repo = library?.provenance.kind === "github" && library.provenance.repo ? `https://github.com/${library.provenance.repo}` : null;

  return (
    <aside className="flex h-full w-96 shrink-0 flex-col overflow-hidden border-l" style={{ borderColor: "var(--app-border)" }} aria-label={name} data-testid="skill-detail-panel">
      <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-4">
        <div className="min-w-0">
          <h2 className="truncate text-[length:var(--text-row)] font-semibold" style={{ color: "var(--app-text-primary)" }}>{name}</h2>
          <p className="mt-0.5 text-[length:var(--text-small)]" style={{ color: "var(--app-text-tertiary)" }}>{sourceLabel}</p>
        </div>
        <IconTooltipButton label={t("resourceLibrary.closeDetail")} className="h-7 w-7 shrink-0" onClick={onClose}>
          <X size={14} />
        </IconTooltipButton>
      </div>

      <div className="app-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        {description && <p className="text-xs leading-relaxed" style={{ color: "var(--app-text-secondary)" }}>{description}</p>}
        {library && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[length:var(--text-small)]" style={{ color: "var(--app-text-secondary)" }}>
            <dt style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.detail.source")}</dt>
            <dd className="select-text break-all font-mono">{skillSourceText(library)}</dd>
            {library.provenance.gitRef && (<><dt style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.detail.ref")}</dt><dd className="font-mono">{library.provenance.gitRef}</dd></>)}
            {library.provenance.commit && (<><dt style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.detail.commit")}</dt><dd className="font-mono">{library.provenance.commit.slice(0, 12)}</dd></>)}
            <dt style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.detail.installedAt")}</dt>
            <dd>{library.installedAt}</dd>
          </dl>
        )}
        {check?.status === "unknown" && check.error && library && isTracked(library) && (
          <p className="break-all text-[length:var(--text-small)]" style={{ color: "var(--app-status-warning, var(--app-text-tertiary))" }}>
            {check.rateLimitedUntil ? t("skillLibrary.detail.rateLimited", { until: check.rateLimitedUntil }) : t("skillLibrary.detail.checkError", { error: check.error })}
          </p>
        )}
        {check?.status === "update" && check.compareUrl && (
          <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => void openExternalUrl(check.compareUrl!)}>
            <ExternalLink size={12} className="mr-1" />{t("skillLibrary.detail.compare")}
          </Button>
        )}
        {dirPath && <p className="select-text break-all font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-tertiary)" }}>{dirPath}</p>}

        {library && (
          <div className="flex flex-wrap gap-1.5">
            {isTracked(library) && !isGone(library, check) && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onUpdate(library)}>
                {busy ? <Loader2 size={13} className="mr-1 animate-spin" /> : <ArrowUpCircle size={13} className="mr-1" />}{t("skillLibrary.update")}
              </Button>
            )}
            {repo && (
              <Button size="sm" variant="ghost" onClick={() => void openExternalUrl(repo)}><ExternalLink size={13} className="mr-1" />{t("skillLibrary.detail.openSource")}</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void revealItemInDir(library.dirPath).catch((reason) => handleErrorSilent(reason, "reveal skill dir"))}>
              <FolderOpen size={13} className="mr-1" />{t("skillLibrary.detail.openFolder")}
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => onRemove(library)}>
              <Trash2 size={13} className="mr-1" />{t("skillLibrary.remove")}
            </Button>
          </div>
        )}

        {loading ? (
          <p role="status" className="flex items-center gap-1.5 text-xs" style={{ color: "var(--app-text-tertiary)" }}><Loader2 size={12} className="animate-spin" />{t("skillLibrary.detail.loading")}</p>
        ) : error ? (
          <p role="alert" className="break-all text-xs" style={{ color: "var(--app-status-danger)" }}>{error}</p>
        ) : content ? (
          <>
            {content.files.length > 0 && (
              <div>
                <h3 className="mb-1 text-[length:var(--text-micro)] font-medium" style={{ color: "var(--app-text-tertiary)" }}>{t("skillLibrary.detail.files", { count: content.files.length })}</h3>
                <ul className="space-y-0.5 font-mono text-[length:var(--text-micro)]" style={{ color: "var(--app-text-secondary)" }}>
                  {content.files.map((file) => <li key={file} className="truncate">{file}</li>)}
                </ul>
              </div>
            )}
            <pre className="select-text whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-[length:var(--text-micro)] leading-relaxed" style={{ borderColor: "var(--app-border)", color: "var(--app-text-secondary)" }} data-testid="skill-detail-content">
              {content.content}
            </pre>
          </>
        ) : null}
      </div>
    </aside>
  );
}
