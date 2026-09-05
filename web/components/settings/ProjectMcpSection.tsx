import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { Plug, Trash2, SquarePen, Server, ServerOff, Save, X, Loader2, Import } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMcpStore, useWorkspacesStore } from "@/stores";
import { workspaceNameForProject } from "@/hooks/useQuickCommandsSync";
import type { McpLayerTarget, McpServerConfig } from "@/types";
import { parseEnvLines, formatEnvLines } from "@/utils";
import ScopeBanner from "./ScopeBanner";

interface FormState {
  name: string;
  command: string;
  args: string;
  env: string;
}

const emptyForm: FormState = {
  name: "",
  command: "",
  args: "",
  env: "",
};

interface ProjectMcpSectionProps {
  projectPath: string;
  /** 工作空间视图（docs/98 workspace-first）：projectPath 为空时生效 */
  workspaceName?: string;
}

export default function ProjectMcpSection({
  projectPath,
  workspaceName,
}: ProjectMcpSectionProps) {
  const { t } = useTranslation("settings");
  const { t: tNotify } = useTranslation("notifications");

  const workspaceMode = !projectPath && !!workspaceName;
  const target = useMemo<McpLayerTarget>(
    () => (workspaceMode ? { workspaceName: workspaceName! } : { projectPath }),
    [workspaceMode, workspaceName, projectPath],
  );
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  // 项目视图里旧配置默认导入到项目所属工作空间；找不到所属工作空间则导入到项目覆盖层
  const owningWorkspace = useMemo(
    () => (workspaceMode ? undefined : workspaceNameForProject(workspaces, projectPath)),
    [workspaceMode, workspaces, projectPath],
  );

  const servers = useMcpStore((s) => s.servers);
  const legacyServers = useMcpStore((s) => s.legacyServers);
  const loading = useMcpStore((s) => s.loading);
  const loadServers = useMcpStore((s) => s.loadServers);
  const loadLegacyServers = useMcpStore((s) => s.loadLegacyServers);
  const importLegacyServers = useMcpStore((s) => s.importLegacyServers);
  const upsertServer = useMcpStore((s) => s.upsertServer);
  const removeServer = useMcpStore((s) => s.removeServer);

  const [editing, setEditing] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    loadServers(target);
    if (!workspaceMode) loadLegacyServers(projectPath);
  }, [target, workspaceMode, projectPath, loadServers, loadLegacyServers]);

  const legacyPending = useMemo(
    () => Object.keys(legacyServers).filter((name) => !(name in servers)),
    [legacyServers, servers],
  );

  async function handleImportLegacy() {
    setImporting(true);
    try {
      const imported = await importLegacyServers(projectPath, owningWorkspace);
      toastOk(tNotify("mcpLegacyImported", { count: imported.length }));
      await loadLegacyServers(projectPath);
    } catch (e) {
      toastErr(tNotify("operationFailed", { error: String(e) }));
    } finally {
      setImporting(false);
    }
  }

  const resetForm = useCallback(() => {
    setForm({ ...emptyForm });
    setEditing(false);
    setEditingName(null);
  }, []);

  function handleNew() {
    resetForm();
    setEditing(true);
  }

  function handleEdit(name: string, config: McpServerConfig) {
    setEditingName(name);
    setForm({
      name,
      command: config.command,
      args: config.args.join(" "),
      env: formatEnvLines(config.env),
    });
    setEditing(true);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.command.trim()) {
      toastErr(tNotify("mcpNameCommandRequired"));
      return;
    }
    try {
      const args = form.args.trim()
        ? form.args.trim().split(/\s+/)
        : [];
      const env = parseEnvLines(form.env);

      // 如果是重命名（编辑时名称改变），删除旧的
      if (editingName && editingName !== form.name.trim()) {
        await removeServer(target, editingName);
      }

      await upsertServer(target, form.name.trim(), form.command.trim(), args, env);
      toastOk(tNotify(editingName ? "mcpServerUpdated" : "mcpServerAdded"));
      resetForm();
    } catch (e) {
      toastErr(tNotify("operationFailed", { error: String(e) }));
    }
  }

  async function handleDelete(name: string) {
    try {
      await removeServer(target, name);
      toastOk(tNotify("mcpServerDeleted"));
      if (editingName === name) resetForm();
    } catch (e) {
      toastErr(tNotify("operationFailed", { error: String(e) }));
    }
  }

  const entries = Object.entries(servers);

  return (
    <div className="flex flex-col h-full">
      {/* 作用域徽标：工作空间层 + 跨层跳转（批 5 配置收敛） */}
      <div className="px-4 pt-3">
        <ScopeBanner
          scope="workspace"
          descriptionKey="scope.mcpWorkspaceDesc"
          link={{ labelKey: "scope.editGlobalMcp", paneId: "shared-mcp" }}
        />
      </div>

      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Server size={16} className="text-muted-foreground" />
          <span className="text-sm font-medium">{t("mcpTitle")}</span>
          <Badge variant="outline" className="text-xs max-w-40 truncate" title={workspaceMode ? workspaceName : projectPath}>
            {workspaceMode ? t("mcpLayerWorkspace", { name: workspaceName }) : t("mcpLayerProject")}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {entries.length}
          </Badge>
        </div>
        <Button size="sm" variant="outline" onClick={handleNew}>
          <Plug size={14} className="mr-1" />
          {t("mcpAdd")}
        </Button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          {workspaceMode ? t("mcpLayerWorkspaceHint") : t("mcpLayerProjectHint")}
        </p>

        {!workspaceMode && legacyPending.length > 0 && (
          <div className="flex items-start gap-3 p-3 rounded-lg border border-border bg-muted/40">
            <Import size={16} className="mt-0.5 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0 space-y-1">
              <p className="text-xs">{t("mcpLegacyFound", { count: legacyPending.length })}</p>
              <p className="text-xs text-muted-foreground font-mono truncate">{legacyPending.join(", ")}</p>
            </div>
            <Button size="sm" variant="secondary" disabled={importing} onClick={handleImportLegacy}>
              {importing ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Import size={14} className="mr-1" />}
              {owningWorkspace
                ? t("mcpLegacyImportToWorkspace", { name: owningWorkspace })
                : t("mcpLegacyImportToProject")}
            </Button>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            <span>{t("loading", { ns: "common" })}</span>
          </div>
        )}

        {!loading && entries.length === 0 && !editing && (
          <div className="text-center py-12 text-muted-foreground">
            <ServerOff size={28} className="mx-auto mb-3 opacity-40" />
            <p className="text-xs">{t("mcpNoServers")}</p>
            <p className="text-xs mt-1">{t("mcpNoServersHint")}</p>
          </div>
        )}

        {/* 服务器列表 */}
        {entries.map(([name, config]) => (
          <div
            key={name}
            className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium truncate">{name}</span>
              </div>
              <div className="text-xs text-muted-foreground font-mono truncate">
                {config.command} {config.args.join(" ")}
              </div>
              {Object.keys(config.env).length > 0 && (
                <div className="mt-1 flex gap-1 flex-wrap">
                  {Object.keys(config.env).map((k) => (
                    <Badge key={k} variant="outline" className="text-[10px]">
                      {k}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label={t("mcpEdit")}
                onClick={() => handleEdit(name, config)}
              >
                <SquarePen size={13} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-destructive"
                aria-label={t("mcpDelete")}
                onClick={() => handleDelete(name)}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          </div>
        ))}

        {/* 编辑表单 */}
        {editing && (
          <div className="p-4 rounded-lg border-2 border-primary/30 bg-card space-y-3">
            <h4 className="text-sm font-medium">
              {editingName ? t("mcpEditServer") : t("mcpAddServer")}
            </h4>

            <FormField label={t("mcpServerName")} className="space-y-1" labelClassName="text-xs">
              {({ id }) => (
                <Input
                  id={id}
                  value={form.name}
                  onChange={(e) =>
                    setForm({ ...form, name: e.target.value })
                  }
                  placeholder={t("mcpServerNamePlaceholder")}
                  className="h-8 text-sm"
                />
              )}
            </FormField>

            <FormField label={t("mcpCommand")} className="space-y-1" labelClassName="text-xs">
              {({ id }) => (
                <Input
                  id={id}
                  value={form.command}
                  onChange={(e) =>
                    setForm({ ...form, command: e.target.value })
                  }
                  placeholder={t("mcpCommandPlaceholder")}
                  className="h-8 text-sm font-mono"
                />
              )}
            </FormField>

            <FormField label={t("mcpArgs")} className="space-y-1" labelClassName="text-xs">
              {({ id }) => (
                <Input
                  id={id}
                  value={form.args}
                  onChange={(e) =>
                    setForm({ ...form, args: e.target.value })
                  }
                  placeholder={t("mcpArgsPlaceholder")}
                  className="h-8 text-sm font-mono"
                />
              )}
            </FormField>

            <FormField label={t("mcpEnv")} className="space-y-1" labelClassName="text-xs">
              {({ id }) => (
                <textarea
                  id={id}
                  value={form.env}
                  onChange={(e) =>
                    setForm({ ...form, env: e.target.value })
                  }
                  placeholder={t("mcpEnvPlaceholder")}
                  className="w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                />
              )}
            </FormField>

            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={resetForm}>
                <X size={14} className="mr-1" />
                {t("cancel", { ns: "common" })}
              </Button>
              <Button size="sm" onClick={handleSave}>
                <Save size={14} className="mr-1" />
                {t("save", { ns: "common" })}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
