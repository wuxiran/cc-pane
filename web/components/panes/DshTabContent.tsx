import { memo, useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab } from "@/types";
import { usePanesStore, useWorkspacesStore } from "@/stores";
import { dshService } from "@/services/dshService";
import { isTauriRuntime } from "@/services/runtime";
import BrowserTabContent from "./BrowserTabContent";

interface DshTabContentProps {
  tab: Tab;
}

/**
 * DeepSeek Harness 窗格。
 *
 * dsh 没有 TUI——它的界面是本地 Web UI，所以这里的职责是「先把进程拉起来，
 * 拿到 OS 分配的端口，再把渲染交给浏览器窗格」。webview 直接导航
 * `http://127.0.0.1:<port>`，origin 即 loopback，**天然通过 dsh 的
 * `/api` browser-trust fence**（跨源 fetch 会被它以 403 拒绝，所以嵌 iframe
 * 或在我们页面里 fetch 都不成立，只有 webview 导航这一条路）。
 *
 * 进程回收**不在这里**：卸载不等于关标签（切走、休眠、快照替换都会卸载，
 * 而进程要活着）。停进程归 tabLifecycle 登记表的 onClosed，那条路径在
 * 组件从未挂载时也能跑通。
 */
export default memo(function DshTabContent({ tab }: DshTabContentProps) {
  const { t } = useTranslation("panes");
  const updateBrowserTab = usePanesStore((s) => s.updateBrowserTab);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const boot = useCallback(async () => {
    setError(null);
    try {
      // tab.workspacePath 只在建标签时快照一次——布局恢复出来的旧标签、
      // 以及本次改动之前建的标签都没有它。回落到当前选中的工作空间，
      // 否则那些标签会永远挤在共享的 "default" 实例里。
      const workspacePath =
        tab.workspacePath || useWorkspacesStore.getState().selectedWorkspace()?.path;
      const instance = await dshService.start(
        tab.id,
        tab.projectPath || undefined,
        workspacePath || undefined,
      );
      // 端口是 OS 分配的，创建标签时还不知道——起来之后回填，
      // BrowserTabContent 才有 URL 可导航。
      updateBrowserTab(tab.id, { browserUrl: instance.url });
    } catch (cause) {
      startedRef.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [tab.id, tab.projectPath, tab.workspacePath, updateBrowserTab]);

  useEffect(() => {
    if (!isTauriRuntime() || startedRef.current) return;
    // React 19 严格模式 dev 下 useEffect 双挂载：ref 挡住第二次。
    // 后端的 start 本身也幂等（同 tabId 直接返回现有实例），双保险。
    startedRef.current = true;
    void boot();
  }, [boot]);

  const retry = useCallback(() => {
    startedRef.current = true;
    void boot();
  }, [boot]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <TriangleAlert size={28} style={{ color: "var(--app-status-danger)" }} />
        <div className="text-sm" style={{ color: "var(--app-text-secondary)" }}>
          {t("dshStartFailed")}
        </div>
        <div
          className="max-w-lg break-words font-mono text-xs"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          {error}
        </div>
        <button
          type="button"
          onClick={retry}
          className="rounded-md px-3 py-1.5 text-xs"
          style={{
            background: "var(--app-surface-raised)",
            color: "var(--app-text-primary)",
            border: "1px solid var(--app-border)",
          }}
        >
          {t("dshRetry")}
        </button>
      </div>
    );
  }

  if (!tab.browserUrl) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <LoaderCircle size={22} className="animate-spin" style={{ color: "var(--app-accent)" }} />
        <div className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
          {t("dshStarting")}
        </div>
      </div>
    );
  }

  return <BrowserTabContent tab={tab} />;
});
