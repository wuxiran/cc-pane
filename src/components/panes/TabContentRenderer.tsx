import { memo, lazy, Suspense } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Tab } from "@/types";
import TerminalView from "./TerminalView";
import type { TerminalViewHandle } from "./TerminalView";

// 懒加载非终端组件
const McpConfigPanel = lazy(() => import("@/components/settings/ProjectMcpSection"));
const SkillManager = lazy(() => import("@/components/skill/SkillManager"));
const MemoryManager = lazy(() => import("@/components/memory/MemoryManager"));
const FileExplorerView = lazy(() => import("@/components/explorer/FileExplorerView"));
const EditorView = lazy(() => import("@/components/editor/EditorView"));

interface TabContentRendererProps {
  tab: Tab;
  isActive: boolean;
  paneId: string;
  isPoppedOut?: boolean;
  onSessionCreated: (sessionId: string) => void;
  onTerminalRef: (ref: TerminalViewHandle | null) => void;
}

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
      Loading...
    </div>
  );
}

export default memo(function TabContentRenderer({
  tab,
  isActive,
  paneId,
  isPoppedOut,
  onSessionCreated,
  onTerminalRef,
}: TabContentRendererProps) {
  const { t } = useTranslation("panes");
  switch (tab.contentType) {
    case "terminal":
      if (!tab.projectPath) return null;
      if (isPoppedOut) {
        return (
          <div
            className="flex flex-col items-center justify-center h-full select-none gap-4"
            style={{ background: "#1a1a1a" }}
          >
            <ExternalLink size={48} className="opacity-30" style={{ color: "rgba(255,255,255,0.4)" }} />
            <p className="text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>
              {t("poppedOutPlaceholder")}
            </p>
          </div>
        );
      }
      return (
        <TerminalView
          key={tab.reclaimKey ?? 0}
          ref={onTerminalRef}
          sessionId={tab.sessionId}
          projectPath={tab.projectPath}
          isActive={isActive}
          workspaceName={tab.workspaceName}
          providerId={tab.providerId}
          workspacePath={tab.workspacePath}
          launchClaude={tab.launchClaude}
          cliTool={tab.cliTool}
          resumeId={tab.resumeId}
          onSessionCreated={onSessionCreated}
        />
      );

    case "file-explorer":
      if (!tab.projectPath) return null;
      return (
        <Suspense fallback={<LoadingFallback />}>
          <FileExplorerView projectPath={tab.projectPath} />
        </Suspense>
      );

    case "editor":
      if (!tab.filePath || !tab.projectPath) return null;
      return (
        <Suspense fallback={<LoadingFallback />}>
          <EditorView
            filePath={tab.filePath}
            projectPath={tab.projectPath}
            tabId={tab.id}
            paneId={paneId}
          />
        </Suspense>
      );

    case "mcp-config":
      return (
        <Suspense fallback={<LoadingFallback />}>
          <McpConfigPanel projectPath={tab.projectPath} />
        </Suspense>
      );

    case "skill-manager":
      return (
        <Suspense fallback={<LoadingFallback />}>
          <SkillManager projectPath={tab.projectPath} />
        </Suspense>
      );

    case "memory-manager":
      return (
        <Suspense fallback={<LoadingFallback />}>
          <MemoryManager projectPath={tab.projectPath} />
        </Suspense>
      );

    default:
      return null;
  }
});
