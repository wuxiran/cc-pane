// 首页就地完成「新建工作空间」「导入项目」，不再把用户送去侧边栏找入口。
// 新建成功后直接接到导入项目（预选刚建的工作空间），两步一气呵成；随时可取消。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { useWorkspacesStore } from "@/stores";
import { isTauriRuntime, translateError } from "@/utils";
import { useHomeSetupDialogStore } from "./homeSetupDialogStore";

const FIELD_LABEL = "text-[length:var(--text-small)] font-medium text-[var(--app-text-secondary)]";
const FIELD_HINT = "text-[length:var(--text-small)] text-[var(--app-text-tertiary)]";

async function pickDirectory(title: string): Promise<string | null> {
  const selected = await openNativeDialog({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

function DirectoryField({ id, value, onChange, placeholder, pickTitle }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  pickTitle: string;
}) {
  const { t } = useTranslation("home");
  return (
    <div className="flex gap-2">
      <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="flex-1 font-mono" />
      {isTauriRuntime() && (
        <Button
          type="button"
          variant="secondary"
          className="gap-1.5"
          onClick={() => {
            pickDirectory(pickTitle)
              .then((path) => path && onChange(path))
              .catch((error) => toast.error(translateError(error)));
          }}
        >
          <FolderOpen className="size-3.5" aria-hidden="true" />
          {t("setup.browse")}
        </Button>
      )}
    </div>
  );
}

function CreateWorkspaceForm() {
  const { t } = useTranslation("home");
  const create = useWorkspacesStore((s) => s.create);
  const { open, close } = useHomeSetupDialogStore();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const workspace = await create(name.trim(), path.trim() || undefined);
      toast.success(t("setup.workspaceCreated", { name: workspace.name }));
      open("project", workspace.id);
    } catch (error) {
      toast.error(t("setup.createFailed", { error: translateError(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <DialogHeader>
        <DialogTitle>{t("setup.workspaceTitle")}</DialogTitle>
        <DialogDescription>{t("setup.workspaceDesc")}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 py-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="home-setup-ws-name" className={FIELD_LABEL}>{t("setup.workspaceName")}</label>
          <Input id="home-setup-ws-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("setup.workspaceNamePlaceholder")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="home-setup-ws-root" className={FIELD_LABEL}>{t("setup.workspaceRoot")}</label>
          <DirectoryField id="home-setup-ws-root" value={path} onChange={setPath} placeholder={t("setup.workspaceRootPlaceholder")} pickTitle={t("setup.workspaceRoot")} />
          <p className={FIELD_HINT}>{t("setup.workspaceRootHint")}</p>
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={close}>{t("setup.cancel")}</Button>
        <Button type="submit" disabled={!name.trim() || busy}>{t("setup.createAndNext")}</Button>
      </DialogFooter>
    </form>
  );
}

function ImportProjectForm() {
  const { t } = useTranslation("home");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const expandedWorkspaceId = useWorkspacesStore((s) => s.expandedWorkspaceId);
  const addProject = useWorkspacesStore((s) => s.addProject);
  const { workspaceId: preferredId, open, close } = useHomeSetupDialogStore();
  const candidates = useMemo(() => workspaces.filter((ws) => !ws.hidden && !ws.archivedAt), [workspaces]);
  const initialId = [preferredId, expandedWorkspaceId].find((id) => id && candidates.some((ws) => ws.id === id))
    ?? candidates[0]?.id ?? "";
  const [targetId, setTargetId] = useState(initialId);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!targetId && initialId) setTargetId(initialId);
  }, [initialId, targetId]);

  const target = candidates.find((ws) => ws.id === targetId);
  const submit = async () => {
    if (!target || !path.trim() || busy) return;
    setBusy(true);
    try {
      await addProject(target.name, path.trim());
      toast.success(t("setup.projectImported", { name: target.alias || target.name }));
      close();
    } catch (error) {
      toast.error(t("setup.importFailed", { error: translateError(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <DialogHeader>
        <DialogTitle>{t("setup.projectTitle")}</DialogTitle>
        <DialogDescription>{t("setup.projectDesc")}</DialogDescription>
      </DialogHeader>
      {candidates.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-4">
          <p className={FIELD_HINT}>{t("setup.noWorkspace")}</p>
          <Button type="button" size="sm" onClick={() => open("workspace")}>{t("setup.workspaceTitle")}</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-col gap-1.5">
            <span id="home-setup-target-label" className={FIELD_LABEL}>{t("setup.projectWorkspace")}</span>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger aria-labelledby="home-setup-target-label">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((ws) => (
                  <SelectItem key={ws.id} value={ws.id}>{ws.alias || ws.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="home-setup-project-path" className={FIELD_LABEL}>{t("setup.projectPath")}</label>
            <DirectoryField id="home-setup-project-path" value={path} onChange={setPath} placeholder={t("setup.projectPathPlaceholder")} pickTitle={t("setup.projectPath")} />
          </div>
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={close}>{t("setup.cancel")}</Button>
        {candidates.length > 0 && (
          <Button type="submit" disabled={!target || !path.trim() || busy}>{t("setup.import")}</Button>
        )}
      </DialogFooter>
    </form>
  );
}

export default function HomeSetupDialogs() {
  const mode = useHomeSetupDialogStore((s) => s.mode);
  const close = useHomeSetupDialogStore((s) => s.close);
  return (
    <Dialog open={mode !== null} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-md" data-testid="home-setup-dialog">
        {/* key 让两步切换时表单状态各自重置 */}
        {mode === "workspace" && <CreateWorkspaceForm key="workspace" />}
        {mode === "project" && <ImportProjectForm key="project" />}
      </DialogContent>
    </Dialog>
  );
}
