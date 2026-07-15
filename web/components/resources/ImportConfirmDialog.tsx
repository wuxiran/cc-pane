import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, X, Zap, Sparkles, Server, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
 */
export default function ImportConfirmDialog() {
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
    importService.onImportError((m) => toast.error(`导入链接解析失败：${m}`)).then((u) => {
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
  }, []);

  if (!req) return null;

  const meta =
    req.resource === "provider"
      ? { icon: <Zap size={18} />, title: "导入 Provider", accent: "#E8590C" }
      : req.resource === "skill"
        ? { icon: <Sparkles size={18} />, title: "导入 Skill", accent: "#8B5CF6" }
        : { icon: <Server size={18} />, title: "导入 MCP", accent: "#0EA5E9" };

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
      toast.error(`导入失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={() => !busy && setReq(null)}
    >
      <div
        className="w-[440px] max-w-[92vw] rounded-xl overflow-hidden"
        style={{ background: "var(--app-content)", border: "1px solid var(--app-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: "1px solid var(--app-border)" }}>
          <span style={{ color: meta.accent }}>{meta.icon}</span>
          <span className="text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>{meta.title}</span>
          <span className="text-xs ml-1" style={{ color: "var(--app-text-tertiary)" }}>来自外部链接</span>
          <div className="flex-1" />
          <button onClick={() => !busy && setReq(null)} className="opacity-60 hover:opacity-100">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-2 text-sm" style={{ color: "var(--app-text-secondary)" }}>
          {req.resource === "provider" && (
            <>
              <Field k="名称" v={req.name} />
              <Field k="工具" v={req.app} />
              <Field k="Endpoint" v={req.endpoints.join(", ") || "—"} />
              <Field k="API Key" v={req.apiKey ? maskKey(req.apiKey) : "（未提供）"} mono />
            </>
          )}
          {req.resource === "skill" && (
            <>
              {req.id && <Field k="市场 id" v={req.id} />}
              {req.repo && <Field k="仓库" v={req.repo} />}
            </>
          )}
          {req.resource === "mcp" && (
            <>
              <Field k="名称" v={req.name} />
              <Field k="配置" v={JSON.stringify(req.config)} mono />
            </>
          )}
          <div className="text-xs mt-2" style={{ color: "var(--app-text-tertiary)" }}>
            确认后将写入 CC-Panes 全局配置。只导入你信任来源的链接。
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: "1px solid var(--app-border)" }}>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setReq(null)}>取消</Button>
          <Button size="sm" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Download size={14} className="mr-1.5" />}
            确认导入
          </Button>
        </div>
      </div>
    </div>
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
