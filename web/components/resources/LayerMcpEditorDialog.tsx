// 新增或编辑工作空间 / 项目层的 MCP（写 mcp.json）。
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { McpArgumentsInput } from "@/components/settings/McpArgumentsInput";
import { useMcpServerEditor } from "@/components/settings/useMcpServerEditor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { McpLayerTarget, McpServerConfig } from "@/types";
import type { McpLayerKind } from "./mcpLibraryModel";

export interface LayerEditorRequest {
  target: McpLayerTarget;
  layer: McpLayerKind;
  /** 不传表示新增 */
  server?: { name: string; config: McpServerConfig };
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  return (
    <FormField label={label} className="space-y-1" labelClassName="text-xs">
      {({ id }) => children(id)}
    </FormField>
  );
}

export default function LayerMcpEditorDialog({ request, onClose }: { request: LayerEditorRequest; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const { editing, form, editingName, setForm, argsError, resetForm, handleNew, handleEdit, handleSave } = useMcpServerEditor(request.target);

  useEffect(() => {
    if (request.server) handleEdit(request.server.name, request.server.config);
    else handleNew();
    // 只在打开时初始化一次；保存后 editing 变 false 由下面关闭
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 保存成功后 hook 会把 editing 置回 false，这时关闭弹窗；初次渲染 editing 也是 false，要跳过。
  const opened = useRef(false);
  useEffect(() => {
    if (editing) opened.current = true;
    else if (opened.current) onClose();
  }, [editing, onClose]);

  return (
    <Dialog open={editing} onOpenChange={(open) => { if (!open) resetForm(); }}>
      <DialogContent className="sm:max-w-xl" data-testid="layer-mcp-editor">
        <DialogHeader>
          <DialogTitle className="text-base">{editingName ? t("mcpEditServer") : t("mcpAddServer")}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {request.layer === "workspace" ? t("mcpLayerWorkspaceHint") : t("mcpLayerProjectHint")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("mcpServerName")}>
              {(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("mcpServerNamePlaceholder")} className="h-8 text-sm" />}
            </Field>
            <Field label={t("mcpCommand")}>
              {(id) => <Input id={id} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder={t("mcpCommandPlaceholder")} className="h-8 font-mono text-sm" />}
            </Field>
          </div>
          <Field label={t("mcpArgs")}>
            {(id) => <McpArgumentsInput id={id} value={form.args} onChange={(args) => setForm({ ...form, args })} error={argsError} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("mcpDescriptionZh")}>
              {(id) => <Input id={id} value={form.descriptionZh} onChange={(e) => setForm({ ...form, descriptionZh: e.target.value })} placeholder={t("mcpDescriptionPlaceholder")} className="h-8 text-sm" />}
            </Field>
            <Field label={t("mcpDescriptionEn")}>
              {(id) => <Input id={id} value={form.descriptionEn} onChange={(e) => setForm({ ...form, descriptionEn: e.target.value })} placeholder={t("mcpDescriptionPlaceholder")} className="h-8 text-sm" />}
            </Field>
          </div>
          <Field label={t("mcpEnv")}>
            {(id) => (
              <textarea
                id={id}
                value={form.env}
                onChange={(e) => setForm({ ...form, env: e.target.value })}
                placeholder={t("mcpEnvPlaceholder")}
                className="h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            )}
          </Field>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => resetForm()}>{tCommon("cancel")}</Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={Boolean(argsError)}>{tCommon("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
