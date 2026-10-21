import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy, ExternalLink, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { canUseLocalFileActions, filePreviewService } from "@/services/filePreviewService";
import { toastErr, toastOk } from "@/lib/feedback";
import { navigationBreadcrumbs, normalizeNavigationPath } from "@/utils/path";

interface FilePreviewActionsProps {
  filePath: string;
  projectPath?: string;
  isRemote?: boolean;
}

function relativeFilePath(filePath: string, projectPath: string | undefined, remote: boolean): string | null {
  if (!projectPath) return null;
  const style = remote ? "posix" : "auto";
  const path = normalizeNavigationPath(filePath, style);
  const root = normalizeNavigationPath(projectPath, style).replace(/\/$/, "");
  const insensitive = !remote && (/^[A-Za-z]:/.test(path) || path.startsWith("//"));
  const startsInside = insensitive
    ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : path.startsWith(`${root}/`);
  return startsInside ? path.slice(root.length + 1) : null;
}

export default function FilePreviewActions({ filePath, projectPath, isRemote = false }: FilePreviewActionsProps) {
  const { t } = useTranslation("editor");
  const [busy, setBusy] = useState(false);
  const relativePath = relativeFilePath(filePath, projectPath, isRemote);
  const fileName = navigationBreadcrumbs(filePath, isRemote ? "posix" : "auto").slice(-1)[0]?.label ?? filePath;
  const desktopActions = canUseLocalFileActions(filePath, isRemote);
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toastOk(t("pathCopied", { defaultValue: "Copied" }));
    } catch {
      toastErr(t("copyPathFailed", { defaultValue: "Could not copy the path" }));
    }
  };
  const run = async (action: "openDefault" | "reveal") => {
    if (busy || !desktopActions) return;
    setBusy(true);
    try {
      await filePreviewService.runDesktopAction(filePath, action, isRemote);
    } catch {
      toastErr(t("fileActionFailed", { defaultValue: "Could not open the file. It may have moved or been deleted." }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 rounded-lg px-2" aria-label={t("copyPath", { defaultValue: "Copy path" })} title={t("copyPath", { defaultValue: "Copy path" })}>
            <Copy size={13} /><ChevronDown size={10} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void copy(filePath)}>{t("copyAbsolutePath", { defaultValue: "Copy full path" })}</DropdownMenuItem>
          {relativePath && <DropdownMenuItem onSelect={() => void copy(relativePath)}>{t("copyRelativePath", { defaultValue: "Copy project-relative path" })}</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => void copy(fileName)}>{t("copyFileName", { defaultValue: "Copy file name" })}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {desktopActions && <>
        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg" disabled={busy} onClick={() => void run("openDefault")} aria-label={t("openDefaultApp", { defaultValue: "Open in default app" })} title={t("openDefaultApp", { defaultValue: "Open in default app" })}>
          <ExternalLink size={14} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 rounded-lg" disabled={busy} onClick={() => void run("reveal")} aria-label={t("revealInFileManager", { defaultValue: "Show in file manager" })} title={t("revealInFileManager", { defaultValue: "Show in file manager" })}>
          <FolderOpen size={14} />
        </Button>
      </>}
    </div>
  );
}
