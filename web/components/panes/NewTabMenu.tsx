// 标签栏右端的「＋」入口。
//
// 拆出来是因为它已经不是一个按钮了：浏览器 tab 此前**只能**靠 MCP open_browser_tab
// 打开、桌面端完全没有入口，file-explorer 也只有移动端原型能开。现在 ＋ 左键仍是
// 「新建终端」（保持老手感），右侧箭头展开其余类型。
import { Bot, ChevronDown, FileText, FolderTree, Globe2, Plus, Server, Terminal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TFunction } from "i18next";

/**
 * ＋ 入口能触发的全部动作。独立成型是为了让 TabBar 整组透传——
 * 它只是路过，不该把这六个 handler 平铺进自己的 prop 面。
 * 可选项缺省即隐藏对应菜单项（如无项目路径时没有目录树可开）。
 */
export interface NewTabActions {
  onAdd: () => void;
  /** 新建浏览器 tab（桌面端此前无入口，只能靠 MCP open_browser_tab） */
  onAddBrowser?: () => void;
  /** 新建 DeepSeek Harness tab（托管 dsh web 进程 + 浏览器窗格渲染） */
  onAddDsh?: () => void;
  /** 打开文件（走系统文件选择器，落在本 pane 的 editor tab） */
  onAddFile?: () => void;
  /** 打开目录树 tab（file-explorer，桌面端此前无入口） */
  onAddFileExplorer?: () => void;
  /** 打开 SSH 机器管理面板 */
  onAddSsh?: () => void;
}

export default function NewTabMenu({
  addBtnClass,
  addIconClass,
  onAdd,
  onAddBrowser,
  onAddDsh,
  onAddFile,
  onAddFileExplorer,
  onAddSsh,
  t,
}: NewTabActions & {
  addBtnClass: string;
  addIconClass: string;
  t: TFunction<"panes">;
}) {
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        aria-label={t("newTab")}
        className={`${addBtnClass} shrink-0 rounded-l-lg transition-colors text-[var(--app-icon-inactive)] hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]`}
        onClick={onAdd}
      >
        <Plus className={addIconClass} />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("newTabMenu")}
            className="flex h-6 w-3.5 shrink-0 items-center justify-center rounded-r-lg text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onSelect={onAdd}>
            <Terminal /> {t("newTerminalTab")}
          </DropdownMenuItem>
          {onAddBrowser && (
            <DropdownMenuItem onSelect={onAddBrowser}>
              <Globe2 /> {t("newBrowserTab")}
            </DropdownMenuItem>
          )}
          {onAddDsh && (
            <DropdownMenuItem onSelect={onAddDsh}>
              <Bot /> {t("newDshTab")}
            </DropdownMenuItem>
          )}
          {onAddFile && (
            <DropdownMenuItem onSelect={onAddFile}>
              <FileText /> {t("openFileTab")}
            </DropdownMenuItem>
          )}
          {onAddFileExplorer && (
            <DropdownMenuItem onSelect={onAddFileExplorer}>
              <FolderTree /> {t("newFileExplorerTab")}
            </DropdownMenuItem>
          )}
          {onAddSsh && (
            <DropdownMenuItem onSelect={onAddSsh}>
              <Server /> {t("newSshTab")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
