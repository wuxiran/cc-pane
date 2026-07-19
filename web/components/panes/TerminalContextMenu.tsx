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
  RefreshCw,
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
   * macOS 上终端区域有原生菜单拦截器（TerminalView 的 native-menu blockers），
   * 右键事件在捕获阶段就被吃掉，挂了菜单也弹不出来，索性不挂。
   */
  enabled?: boolean;
  getSelection: () => string;
  /** 打开瞬间读取会话 id，null 时"复制会话 ID"禁用。 */
  getSessionId: () => string | null;
  onCopySelection: () => void;
  onSelectAll: () => void;
  onPaste: () => void;
  /** 刷新显示：清字形图集 + 强制 refit + 重绘，修花屏/变形/未铺满。 */
  onRefreshTerminal: () => void;
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
  onRefreshTerminal,
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
        <ContextMenuItem onSelect={onRefreshTerminal}>
          <RefreshCw /> {t("terminalRefresh")}
        </ContextMenuItem>
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
