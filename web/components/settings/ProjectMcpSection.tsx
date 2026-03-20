import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plug, Trash2, SquarePen, Server, ServerOff, Save, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMcpStore } from "@/stores";
import type { McpServerConfig } from "@/types";
import { parseEnvLines, formatEnvLines } from "@/utils";

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
}

export default function ProjectMcpSection({
  projectPath,
}: ProjectMcpSectionProps) {
  const { t } = useTranslation("settings");
  const { t: tNotify } = useTranslation("notifications");

  const servers = useMcpStore((s) => s.servers);
  const loading = useMcpStore((s) => s.loading);
  const loadServers = useMcpStore((s) => s.loadServers);
  const upsertServer = useMcpStore((s) => s.upsertServer);
  const removeServer = useMcpStore((s) => s.removeServer);

  const [editing, setEditing] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });

  useEffect(() => {
    loadServers(projectPath);
  }, [projectPath, loadServers]);

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
      toast.error(tNotify("mcpNameCommandRequired"));
      return;
    }
    try {
      const args = form.args.trim()
        ? form.args.trim().split(/\s+/)
        : [];
      const env = parseEnvLines(form.env);

      // 如果是重命名（编辑时名称改变），删除旧的
      if (editingName && editingName !== form.name.trim()) {
        await removeServer(projectPath, editingName);
      }

      await upsertServer(projectPath, form.name.trim(), form.command.trim(), args, env);
      toast.success(tNotify(editingName ? "mcpServerUpdated" : "mcpServerAdded"));
      resetForm();
    } catch (e) {
      toast.error(tNotify("operationFailed", { error: String(e) }));
    }
  }

  async function handleDelete(name: string) {
    try {
      await removeServer(projectPath, name);
      toast.success(tNotify("mcpServerDeleted"));
      if (editingName === name) resetForm();
    } catch (e) {
      toast.error(tNotify("operationFailed", { error: String(e) }));
    }
  }

  const entries = Object.entries(servers);

  return (
    <div className="flex flex-col h-full">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-muted-foreground" />
          <span className="text-sm font-medium">{t("mcpTitle")}</span>
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
                onClick={() => handleEdit(name, config)}
              >
                <SquarePen size={13} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-destructive"
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

            <div className="space-y-1">
              <Label className="text-xs">{t("mcpServerName")}</Label>
              <Input
                value={form.name}
                onChange={(e) =>
                  setForm({ ...form, name: e.target.value })
                }
                placeholder={t("mcpServerNamePlaceholder")}
                className="h-8 text-sm"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("mcpCommand")}</Label>
              <Input
                value={form.command}
                onChange={(e) =>
                  setForm({ ...form, command: e.target.value })
                }
                placeholder={t("mcpCommandPlaceholder")}
                className="h-8 text-sm font-mono"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("mcpArgs")}</Label>
              <Input
                value={form.args}
                onChange={(e) =>
                  setForm({ ...form, args: e.target.value })
                }
                placeholder={t("mcpArgsPlaceholder")}
                className="h-8 text-sm font-mono"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">
                {t("mcpEnv")}
              </Label>
              <textarea
                value={form.env}
                onChange={(e) =>
                  setForm({ ...form, env: e.target.value })
                }
                placeholder={t("mcpEnvPlaceholder")}
                className="w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

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
