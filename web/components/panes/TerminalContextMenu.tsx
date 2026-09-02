import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ClipboardPaste,
  Copy,
  ClipboardCopy,
  Eraser,
  FileDown,
  FolderOpen,
  Hash,
  Maximize2,
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
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

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
  onFitTerminal: () => void;
  onFitAllTerminals: () => void;
  /** 刷新显示：清字形图集 + 强制 refit + 重绘，修花屏/变形/未铺满。 */
  onRefreshTerminal: () => void;
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
}

/** 终端区右键菜单：剪贴板操作 / 缓冲区操作 / 项目目录，分组用 Separator 隔开。 */
export default function TerminalContextMenu({
  children,
  enabled = true,
  getSelection,
  getSessionId,
  onCopySelection,
  onSelectAll,
  onPaste,
  onFitTerminal,
  onFitAllTerminals,
  onRefreshTerminal,
  onResetBuffer,
  onClearBuffer,
  onCopyBuffer,
  onExportBuffer,
  onCopySessionId,
  onOpenProjectDir,
}: TerminalContextMenuProps) {
  const { t } = useTranslation("panes");
  // 打开瞬间快照选区/会话状态，决定对应菜单项是否可用。
  const [hasSelection, setHasSelection] = useState(false);
  const [hasSession, setHasSession] = useState(false);

  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          setHasSelection(getSelection().length > 0);
          setHasSession(Boolean(getSessionId()));
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
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onFitTerminal}>
          <Maximize2 /> {t("terminalFit")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onFitAllTerminals}>
          <PanelsTopLeft /> {t("terminalFitAll")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRefreshTerminal}>
          <RefreshCw /> {t("terminalRefresh")}
        </ContextMenuItem>
        {onResetBuffer && (
          <ContextMenuItem onSelect={onResetBuffer}>
            <RotateCcw /> {t("terminalResetBuffer")}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={onClearBuffer}>
          <Eraser /> {t("terminalClearBuffer")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCopyBuffer}>
          <ClipboardCopy /> {t("terminalCopyBuffer")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onExportBuffer}>
          <FileDown /> {t("terminalExportBuffer")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasSession} onSelect={onCopySessionId}>
          <Hash /> {t("terminalCopySessionId")}
        </ContextMenuItem>
        {onOpenProjectDir && (
          <ContextMenuItem onSelect={onOpenProjectDir}>
            <FolderOpen /> {t("terminalOpenProjectDir")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
