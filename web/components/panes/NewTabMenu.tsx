// 标签栏右端的「＋」入口。
//
// 拆出来是因为它已经不是一个按钮了：浏览器 tab 此前**只能**靠 MCP open_browser_tab
// 打开、桌面端完全没有入口，file-explorer 也只有移动端原型能开。现在 ＋ 左键仍是
// 「新建终端」（保持老手感），右侧箭头展开其余类型。
import { ChevronDown, FileText, FolderTree, Globe2, Plus, Terminal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TFunction } from "i18next";

export default function NewTabMenu({
  addBtnClass,
  addIconClass,
  onAdd,
  onAddBrowser,
  onAddFile,
  onAddFileExplorer,
  t,
}: {
  addBtnClass: string;
  addIconClass: string;
  onAdd: () => void;
  onAddBrowser?: () => void;
  onAddFile?: () => void;
  onAddFileExplorer?: () => void;
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
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
