import { Suspense, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ClipboardPaste,
  Copy,
  ClipboardCopy,
  Eraser,
  FileDown,
  FolderOpen,
  GitFork,
  Hash,
  MoreHorizontal,
  PanelsTopLeft,
  RefreshCw,
  RotateCcw,
  TextSelect,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { lazyWithRetry } from "@/lib/lazyRetry";
import type {
  TerminalSessionMenu,
  TerminalSessionMenuState,
} from "./terminal/useTerminalSessionMenu";

const TerminalForkDialog = lazyWithRetry(
  () => import("@/components/chatfork/TerminalForkDialog"),
  "TerminalForkDialog",
);

interface TerminalContextMenuProps {
  children: ReactNode;
  /**
   * false 时直接渲染 children 不挂菜单。
   *
   * 历史：macOS 上曾因 TerminalView 的 native-menu blocker 在捕获阶段
   * stopImmediatePropagation 掉 contextmenu，挂了菜单也弹不出来，故当时传 `!IS_MAC`
   * 直接不挂——副作用是 mac 右键完全没有菜单。blocker 现已对 contextmenu 放行
   * （只保留 preventDefault 压制原生菜单），**全平台都应启用**，调用方无需再传此项。
   */
  enabled?: boolean;
  getSelection: () => string;
  /** 打开瞬间读取会话 id，null 时"复制会话 ID"禁用。 */
  getSessionId: () => string | null;
  onCopySelection: () => void;
  onSelectAll: () => void;
  onPaste: () => void;
  /** 修复显示：清字形图集 + 强制 refit 并同步后端 + 让 CLI 重绘，修花屏/变形/未铺满/错行。 */
  onRepairDisplay: () => void;
  onFitAllTerminals: () => void;
  /**
   * 重置缓冲区：优先从后端快照重建画面（含可恢复的回滚历史），快照不可得才
   * 回退成破坏性 xterm.reset()；随后 SIGWINCH 让 CLI 补画当前帧。修「刷新显示」
   * 救不了的 buffer 级错乱（docs/73 A 类）。handler 内有确认。
   * 未提供时（镜像/只读视图无权驱动 PTY，重置只会得到空屏）不渲染该菜单项。
   */
  onResetBuffer?: () => void;
  onClearBuffer: () => void;
  onCopyBuffer: () => void;
  onExportBuffer: () => void;
  onCopySessionId: () => void;
  /** 未提供时（无 projectPath）不渲染该菜单项。 */
  onOpenProjectDir?: () => void;
  /** 未提供时（无 tab 的视图，如 SelfChat）不显示分叉和会话相关的复制项。 */
  sessionMenu?: TerminalSessionMenu;
}

const NO_SESSION_STATE: TerminalSessionMenuState = {
  canFork: false,
  hasResumeCommand: false,
  hasWorkingDir: false,
  hasTranscript: false,
  hasDeepLink: false,
};

/** 终端区右键菜单：第一层只留常用项，低频和有破坏性的操作收进「复制」「更多」子菜单。 */
export default function TerminalContextMenu({
  children,
  enabled = true,
  getSelection,
  getSessionId,
  onCopySelection,
  onSelectAll,
  onPaste,
  onRepairDisplay,
  onFitAllTerminals,
  onResetBuffer,
  onClearBuffer,
  onCopyBuffer,
  onExportBuffer,
  onCopySessionId,
  onOpenProjectDir,
  sessionMenu,
}: TerminalContextMenuProps) {
  const { t } = useTranslation("panes");
  // 打开瞬间快照选区/会话状态，决定对应菜单项是否可用。
  const [hasSelection, setHasSelection] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [sessionState, setSessionState] = useState(NO_SESSION_STATE);
  const [forkOpen, setForkOpen] = useState(false);

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <>
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          setHasSelection(getSelection().length > 0);
          setHasSession(Boolean(getSessionId()));
          setSessionState(sessionMenu?.getState() ?? NO_SESSION_STATE);
        }
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem disabled={!hasSelection} onSelect={onCopySelection}>
          <Copy /> {t("terminalCopySelection")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onSelectAll}>
          <TextSelect /> {t("terminalSelectAll")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onPaste}>
          <ClipboardPaste /> {t("terminalPaste")}
        </ContextMenuItem>
        {sessionState.canFork && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setForkOpen(true)}>
              <GitFork /> {t("terminalForkSession")}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onRepairDisplay}>
          <RefreshCw /> {t("terminalRepairDisplay")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ClipboardCopy /> {t("terminalCopyMenu")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            <ContextMenuItem onSelect={onCopyBuffer}>{t("terminalCopyBuffer")}</ContextMenuItem>
            <ContextMenuItem disabled={!hasSession} onSelect={onCopySessionId}>
              <Hash /> {t("terminalCopySessionId")}
            </ContextMenuItem>
            {sessionState.hasResumeCommand && (
              <ContextMenuItem onSelect={sessionMenu?.onCopyResumeCommand}>
                {t("terminalCopyResumeCommand")}
              </ContextMenuItem>
            )}
            {sessionState.hasWorkingDir && (
              <ContextMenuItem onSelect={sessionMenu?.onCopyWorkingDir}>
                {t("terminalCopyWorkingDir")}
              </ContextMenuItem>
            )}
            {sessionMenu && (
              <ContextMenuItem onSelect={sessionMenu.onCopySessionInfo}>
                {t("terminalCopySessionInfo")}
              </ContextMenuItem>
            )}
            {sessionState.hasTranscript && (
              <>
                <ContextMenuItem onSelect={sessionMenu?.onCopyMarkdown}>
                  {t("terminalCopyMarkdown")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={sessionMenu?.onCopyTranscriptPath}>
                  {t("terminalCopyTranscriptPath")}
                </ContextMenuItem>
              </>
            )}
            {sessionState.hasDeepLink && (
              <ContextMenuItem onSelect={sessionMenu?.onCopyDeepLink}>
                {t("terminalCopyDeepLink")}
              </ContextMenuItem>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <MoreHorizontal /> {t("terminalMoreMenu")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56">
            <ContextMenuItem onSelect={onFitAllTerminals}>
              <PanelsTopLeft /> {t("terminalFitAll")}
            </ContextMenuItem>
            {onResetBuffer && (
              <ContextMenuItem onSelect={onResetBuffer}>
                <RotateCcw /> {t("terminalResetBuffer")}
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={onExportBuffer}>
              <FileDown /> {t("terminalExportBuffer")}
            </ContextMenuItem>
            {sessionState.hasTranscript && (
              <ContextMenuItem onSelect={sessionMenu?.onExportTranscript}>
                <FileDown /> {t("terminalExportTranscript")}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onClearBuffer}>
              <Eraser /> {t("terminalClearBuffer")}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        {onOpenProjectDir && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onOpenProjectDir}>
              <FolderOpen /> {t("terminalOpenProjectDir")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
    {forkOpen && sessionMenu && (
      <Suspense fallback={null}>
        <TerminalForkDialog
          open={forkOpen}
          onOpenChange={setForkOpen}
          tabId={sessionMenu.tabId}
          leafId={sessionMenu.leafId}
        />
      </Suspense>
    )}
    </>
  );
}
