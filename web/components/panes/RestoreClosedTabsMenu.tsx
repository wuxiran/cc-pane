// 「恢复已关闭标签」子菜单：列出可恢复的标签，点哪个恢复哪个。
// 只想恢复最近关闭的那个时用快捷键（reopenClosedTab 不带快照），提示挂在第一行。
import { FileText, Globe, History, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CommandShortcutHint } from "@/components/commands/CommandMenuItem";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { usePanesStore } from "@/stores";
import type { ClosedTabSnapshot } from "@/stores/panesStoreTypes";

function lastPathSegment(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

/** 终端/文件的位置；浏览器的 URL 已经是定位信息，直接显示。 */
function snapshotLocation(snapshot: ClosedTabSnapshot): string {
  if (snapshot.contentType === "browser") return snapshot.browserUrl ?? "";
  return snapshot.filePath ?? snapshot.projectPath ?? "";
}

function snapshotTitle(snapshot: ClosedTabSnapshot): string {
  return snapshot.title
    || snapshot.browserManualTitle
    || snapshot.browserPageTitle
    || lastPathSegment(snapshotLocation(snapshot));
}

function SnapshotIcon({ snapshot }: { snapshot: ClosedTabSnapshot }) {
  if (snapshot.contentType === "browser") return <Globe />;
  if (snapshot.contentType === "editor") return <FileText />;
  return <Terminal />;
}

export default function RestoreClosedTabsMenu({ paneId }: { paneId: string }) {
  const { t } = useTranslation("panes");
  const closedTabs = usePanesStore((state) => state.closedTabs);

  if (closedTabs.length === 0) {
    return (
      <ContextMenuItem disabled>
        <History /> {t("restoreClosedTabs", { count: 0 })}
      </ContextMenuItem>
    );
  }

  const newestFirst = [...closedTabs].reverse();
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <History /> {t("restoreClosedTabs", { count: closedTabs.length })}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-96 w-80 overflow-y-auto">
        {newestFirst.map((snapshot, index) => {
          const location = snapshotLocation(snapshot);
          return (
            <ContextMenuItem
              // 同一标签可以被关闭多次，title/路径都可能重复，栈内位置才唯一。
              key={closedTabs.length - index}
              title={location}
              onSelect={() => usePanesStore.getState().reopenClosedTab(paneId, snapshot)}
            >
              <SnapshotIcon snapshot={snapshot} />
              <span className="min-w-0 flex-1 truncate">{snapshotTitle(snapshot)}</span>
              {index === 0 ? <CommandShortcutHint commandId="reopen-closed-tab" /> : (
                <span className="text-muted-foreground max-w-[40%] shrink-0 truncate text-xs">
                  {lastPathSegment(location)}
                </span>
              )}
            </ContextMenuItem>
          );
        })}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
