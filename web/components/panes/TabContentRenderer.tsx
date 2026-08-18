import { memo, Suspense, useCallback, type ReactNode } from "react";
import { ExternalLink, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab } from "@/types";
import { usePanesStore } from "@/stores";
import { markTabReclaimed } from "@/services";
import { lazyWithRetry } from "@/lib/lazyRetry";
import ErrorBoundary from "@/components/ErrorBoundary";
import TerminalTabContent from "./TerminalTabContent";
import type { TerminalViewHandle } from "./TerminalView";

// 懒加载非终端组件（lazyWithRetry：分片取回失败时自愈，见 lib/lazyRetry.ts）
const McpConfigPanel = lazyWithRetry(() => import("@/components/settings/ProjectMcpSection"), "ProjectMcpSection");
const SkillManager = lazyWithRetry(() => import("@/components/skill/SkillManager"), "SkillManager");
const MemoryManager = lazyWithRetry(() => import("@/components/memory/MemoryManager"), "MemoryManager");
const FileExplorerView = lazyWithRetry(() => import("@/components/explorer/FileExplorerView"), "FileExplorerView");
const EditorView = lazyWithRetry(() => import("@/components/editor/EditorView"), "EditorView");
const BrowserTabContent = lazyWithRetry(() => import("./BrowserTabContent"), "BrowserTabContent");
const DshTabContent = lazyWithRetry(() => import("./DshTabContent"), "DshTabContent");

interface TabContentRendererProps {
  tab: Tab;
  layoutActive: boolean;
  showTerminalStatusBar?: boolean;
  paneId: string;
  isPoppedOut?: boolean;
  onSessionCreated: (sessionId: string, terminalPaneId?: string) => void;
  onSessionExited?: (exitCode: number, terminalPaneId?: string) => void;
  onTerminalRef: (terminalPaneId: string, ref: TerminalViewHandle | null) => void;
  onReconnect?: (terminalPaneId: string) => Promise<string | null>;
}

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
      Loading...
    </div>
  );
}

/**
 * 懒加载 tab 内容的统一包装。
 *
 * ErrorBoundary 必须在 Suspense 外层且**逐 tab 隔离**：一个分片取回失败只应换掉那个
 * 标签的内容区，而不是让 throw 冒泡到 App.tsx 顶层把整个窗口变成错误页。
 */
function LazyContent({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

export default memo(function TabContentRenderer({
  tab,
  layoutActive,
  showTerminalStatusBar,
  paneId,
  isPoppedOut,
  onSessionCreated,
  onSessionExited,
  onTerminalRef,
  onReconnect,
}: TabContentRendererProps) {
  const { t } = useTranslation("panes");

  const handleReclaim = useCallback(() => {
    usePanesStore.getState().markTabReclaimed(tab.id);
    markTabReclaimed(tab.id);
  }, [tab.id]);

  switch (tab.contentType) {
    case "terminal":
      if (!tab.projectPath) return null;
      if (isPoppedOut) {
        return (
          <div
            className="flex flex-col items-center justify-center h-full select-none gap-4"
            style={{ background: "var(--app-terminal-bg)" }}
          >
            <ExternalLink size={48} className="opacity-30" style={{ color: "var(--app-terminal-fg)" }} />
            <p className="text-sm opacity-50" style={{ color: "var(--app-terminal-fg)" }}>
              {t("poppedOutPlaceholder")}
            </p>
            <button
              onClick={handleReclaim}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors"
              style={{
                color: "var(--app-terminal-fg)",
                background: "var(--app-hover)",
                border: "1px solid var(--app-border)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--app-active-bg)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--app-hover)";
              }}
            >
              <Undo2 size={14} />
              {t("reclaimTab")}
            </button>
          </div>
        );
      }
      return (
        <TerminalTabContent
          key={tab.reclaimKey ?? 0}
          tab={tab}
          layoutActive={layoutActive}
          showStatusBar={showTerminalStatusBar}
          onSessionCreated={onSessionCreated}
          onSessionExited={onSessionExited}
          onTerminalRef={onTerminalRef}
          onReconnect={onReconnect}
        />
      );

    case "file-explorer":
      if (!tab.projectPath) return null;
      return (
        <LazyContent>
          <FileExplorerView projectPath={tab.projectPath} />
        </LazyContent>
      );

    case "browser":
      if (!tab.browserUrl) return null;
      return (
        <LazyContent>
          <BrowserTabContent tab={tab} />
        </LazyContent>
      );

    // 与 browser 不同：**没有 browserUrl 也要渲染**——URL 是实例起来后才知道的
    // （端口由 OS 分配），窗格自己负责拉起进程并回填。
    case "dsh":
      return (
        <LazyContent>
          <DshTabContent tab={tab} />
        </LazyContent>
      );

    case "editor":
      if (!tab.filePath || !tab.projectPath) return null;
      return (
        <LazyContent>
          <EditorView
            filePath={tab.filePath}
            projectPath={tab.projectPath}
            tabId={tab.id}
            paneId={paneId}
          />
        </LazyContent>
      );

    case "mcp-config":
      return (
        <LazyContent>
          <McpConfigPanel projectPath={tab.projectPath} />
        </LazyContent>
      );

    case "skill-manager":
      return (
        <LazyContent>
          <SkillManager projectPath={tab.projectPath} />
        </LazyContent>
      );

    case "memory-manager":
      return (
        <LazyContent>
          <MemoryManager projectPath={tab.projectPath} />
        </LazyContent>
      );

    default:
      return null;
  }
});
