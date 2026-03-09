import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "sonner";
import { isTauriReady } from "@/utils";
import { FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { gitClone } from "@/services/workspaceService";

interface GitCloneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName: string;
  onCloned: (path: string) => void;
}

interface GitCloneProgress {
  phase: string;
  percent?: number;
  message: string;
}

function extractRepoName(url: string): string {
  // https://github.com/user/repo.git → "repo"
  // git@github.com:user/repo.git → "repo"
  const match = url.match(/\/([^/]+?)(?:\.git)?$/) || url.match(/:([^/]+?)(?:\.git)?$/);
  return match?.[1] || "";
}

export default function GitCloneDialog({
  open: isOpen,
  onOpenChange,
  workspaceName,
  onCloned,
}: GitCloneDialogProps) {
  const { t } = useTranslation(["dialogs", "common"]);
  const [url, setUrl] = useState("");
  const [parentDir, setParentDir] = useState("");
  const [folderName, setFolderName] = useState("");
  const [folderNameManual, setFolderNameManual] = useState(false);
  const [shallow, setShallow] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState<GitCloneProgress | null>(null);

  // 重置状态
  useEffect(() => {
    if (isOpen) {
      setUrl("");
      setParentDir("");
      setFolderName("");
      setFolderNameManual(false);
      setShallow(false);
      setShowAuth(false);
      setUsername("");
      setPassword("");
      setCloning(false);
      setProgress(null);
    }
  }, [isOpen]);

  // URL 变化时自动推导仓库名
  useEffect(() => {
    if (!folderNameManual && url) {
      setFolderName(extractRepoName(url));
    }
  }, [url, folderNameManual]);

  async function handleSelectDir() {
    try {
      const selected = await open({ directory: true, multiple: false, title: t("selectCloneDir") });
      if (selected) {
        setParentDir(selected);
      }
    } catch (e) {
      toast.error(t("cloneSelectDirFailed", { error: e }));
    }
  }

  function handleFolderNameChange(value: string) {
    setFolderNameManual(true);
    setFolderName(value);
  }

  async function handleClone() {
    if (!url.trim() || !parentDir.trim() || !folderName.trim()) {
      toast.error(t("cloneFieldsRequired"));
      return;
    }

    setCloning(true);
    setProgress(null);

    let unlisten: (() => void) | undefined;
    if (isTauriReady()) {
      unlisten = await getCurrentWebview().listen<GitCloneProgress>("git-clone-progress", (e) => {
        setProgress(e.payload);
      });
    }

    try {
      const clonedPath = await gitClone({
        url: url.trim(),
        targetDir: parentDir.trim(),
        folderName: folderName.trim(),
        shallow,
        username: username || undefined,
        password: password || undefined,
      });
      toast.success(t("cloneSuccess"));
      onCloned(clonedPath);
      onOpenChange(false);
    } catch (e) {
      toast.error(t("cloneFailed", { error: e }));
    } finally {
      unlisten?.();
      setCloning(false);
    }
  }

  const canClone = url.trim() && parentDir.trim() && folderName.trim() && !cloning;

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if (!cloning) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("gitCloneTitle", { name: workspaceName })}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* 仓库 URL */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">{t("repoUrl")}</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              disabled={cloning}
            />
          </div>

          {/* 克隆到目录 */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">{t("cloneDir")}</Label>
            <div className="flex gap-2">
              <Input
                value={parentDir}
                onChange={(e) => setParentDir(e.target.value)}
                placeholder={t("selectParentDir")}
                className="flex-1"
                disabled={cloning}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleSelectDir}
                disabled={cloning}
              >
                <FolderOpen size={14} />
              </Button>
            </div>
          </div>

          {/* 项目文件夹名 */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">{t("projectFolderName")}</Label>
            <Input
              value={folderName}
              onChange={(e) => handleFolderNameChange(e.target.value)}
              placeholder={t("autoDerive")}
              disabled={cloning}
            />
            {parentDir && folderName && (
              <span className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                {t("cloneTo", { path: `${parentDir.replace(/[\\/]$/, "")}\\${folderName}` })}
              </span>
            )}
          </div>

          {/* 浅克隆 */}
          <div
            className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() => !cloning && setShallow(!shallow)}
          >
            <input
              type="checkbox"
              checked={shallow}
              readOnly
              className="cursor-pointer"
              disabled={cloning}
            />
            <span className="text-xs" style={{ color: "var(--app-text-secondary)" }}>
              {t("shallowClone")}
            </span>
          </div>

          {/* 认证区域 */}
          <div className="flex flex-col gap-2">
            <div
              className="flex items-center gap-2 cursor-pointer select-none"
              onClick={() => setShowAuth(!showAuth)}
            >
              <span className="text-xs font-medium" style={{ color: "var(--app-text-tertiary)" }}>
                {showAuth ? "▾" : "▸"} {t("authOptional")}
              </span>
            </div>
            {showAuth && (
              <div className="flex flex-col gap-2 pl-4">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">{t("authUsername")}</Label>
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t("authUsername")}
                    disabled={cloning}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">{t("authPassword")}</Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("authPasswordPlaceholder")}
                    disabled={cloning}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 进度条 */}
          {cloning && (
            <div className="flex flex-col gap-1">
              <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "var(--app-border)" }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${progress?.percent ?? 0}%`,
                    background: "var(--app-accent)",
                  }}
                />
              </div>
              <span className="text-[11px] truncate" style={{ color: "var(--app-text-tertiary)" }}>
                {progress?.message || t("cloning")}
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={cloning}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleClone} disabled={!canClone}>
            {cloning ? t("cloningBtn") : t("cloneBtn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
