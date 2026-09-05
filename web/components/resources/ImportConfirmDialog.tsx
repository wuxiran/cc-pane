import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Download, X, Zap, Sparkles, Server, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { importService, type ImportRequest } from "@/services/importService";
import { useProvidersStore } from "@/stores/useProvidersStore";
import { useSharedMcpStore } from "@/stores";

function maskKey(k?: string | null): string {
  if (!k) return "";
  if (k.length <= 10) return "***";
  return `${k.slice(0, 6)}***${k.slice(-3)}`;
}

/**
 * 一键导入确认弹窗。监听 deep-link 事件（ccpanes://…），把解析结果展示给用户，
 * **用户确认后**才真正落盘（execute_import）。挂在 App 顶层，全局常驻。
 * 基于 Radix Dialog：自带焦点陷阱、Esc 关闭与焦点还原。
 */
export default function ImportConfirmDialog() {
  const { t } = useTranslation(["dialogs", "common"]);
  const [req, setReq] = useState<ImportRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const loadSharedMcp = useSharedMcpStore((s) => s.fetchConfig);

  useEffect(() => {
    let disposed = false;
    let unImport: (() => void) | undefined;
    let unErr: (() => void) | undefined;
    // disposed 守卫：若组件在异步 listen 完成前已卸载，立即解绑，避免监听器泄漏。
    importService.onImport((r) => setReq((cur) => cur ?? r)).then((u) => {
      if (disposed) u();
      else unImport = u;
    });
    importService.onImportError((m) => toast.error(t("importLinkParseFailed", { ns: "dialogs", error: m }))).then((u) => {
      if (disposed) u();
      else unErr = u;
    });
    // 冷启动补领：应用关着时点链接，事件在挂载前已发出，这里主动领取暂存的请求。
    importService.takePendingImport().then((r) => {
      if (!disposed && r) setReq((cur) => cur ?? r);
    });
    return () => {
      disposed = true;
      unImport?.();
      unErr?.();
    };
  }, [t]);

  if (!req) return null;

  // 类别色：Provider/Skill/MCP 分类编码，不随主题变化（见 colorGuard allowlist）
  const meta =
    req.resource === "provider"
      ? { icon: <Zap size={18} />, title: t("dialogs:importDialog.titleProvider"), accent: "#E8590C" }
      : req.resource === "skill"
        ? { icon: <Sparkles size={18} />, title: t("dialogs:importDialog.titleSkill"), accent: "#8B5CF6" }
        : { icon: <Server size={18} />, title: t("dialogs:importDialog.titleMcp"), accent: "#0EA5E9" };

  const onConfirm = async () => {
    setBusy(true);
    try {
      const msg = await importService.executeImport(req);
      toast.success(msg);
      // 刷新对应资源
      if (req.resource === "provider") await loadProviders();
      if (req.resource === "mcp") await loadSharedMcp?.();
      setReq(null);
    } catch (e) {
      toast.error(t("importFailed", { ns: "dialogs", error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) setReq(null);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[440px] max-w-[92vw] gap-0 overflow-hidden rounded-xl p-0"
        style={{ background: "var(--app-content)", border: "1px solid var(--app-border)" }}
      >
        <div
          className="flex items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: "var(--app-border)" }}
        >
          <span style={{ color: meta.accent }} aria-hidden="true">
            {meta.icon}
          </span>
          <DialogTitle
            className="text-sm font-semibold"
            style={{ color: "var(--app-text-primary)" }}
          >
            {meta.title}
          </DialogTitle>
          <span className="ml-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            {t("dialogs:importDialog.sourceHint")}
          </span>
          <div className="flex-1" />
          <DialogClose asChild>
            <button
              type="button"
              aria-label={t("common:close")}
              className="opacity-60 hover:opacity-100"
            >
              <X size={16} />
            </button>
          </DialogClose>
        </div>

        <div
          className="flex flex-col gap-2 px-4 py-4 text-sm"
          style={{ color: "var(--app-text-secondary)" }}
        >
          {req.resource === "provider" && (
            <>
              <Field k={t("dialogs:importDialog.fieldName")} v={req.name} />
              <Field k={t("dialogs:importDialog.fieldTool")} v={req.app} />
              <Field k="Endpoint" v={req.endpoints.join(", ") || "—"} />
              <Field
                k="API Key"
                v={req.apiKey ? maskKey(req.apiKey) : t("dialogs:importDialog.noApiKey")}
                mono
              />
            </>
          )}
          {req.resource === "skill" && (
            <>
              {req.id && <Field k={t("dialogs:importDialog.fieldMarketId")} v={req.id} />}
              {req.repo && <Field k={t("dialogs:importDialog.fieldRepo")} v={req.repo} />}
            </>
          )}
          {req.resource === "mcp" && (
            <>
              <Field k={t("dialogs:importDialog.fieldName")} v={req.name} />
              <Field k={t("dialogs:importDialog.fieldConfig")} v={JSON.stringify(req.config)} mono />
            </>
          )}
          <DialogDescription
            className="mt-2 text-xs"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            {t("dialogs:importDialog.trustHint")}
          </DialogDescription>
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-4 py-3"
          style={{ borderColor: "var(--app-border)" }}
        >
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setReq(null)}>
            {t("common:cancel")}
          </Button>
          <Button size="sm" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Download size={14} className="mr-1.5" />}
            {t("dialogs:importDialog.confirmImport")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <span className="w-16 shrink-0" style={{ color: "var(--app-text-tertiary)" }}>{k}</span>
      <span className={`flex-1 break-all ${mono ? "font-mono text-[12px]" : ""}`} style={{ color: "var(--app-text-primary)" }}>{v}</span>
    </div>
  );
}
