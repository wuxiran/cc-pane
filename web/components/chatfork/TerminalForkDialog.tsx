import { terminalForkSource } from "@/services/chatForkService";
import { collectTabs } from "@/lib/paneSessions";
import { usePanesStore } from "@/stores";
import { eachLayoutTree } from "@/stores/paneLayoutHelpers";
import ChatForkDialog from "./ChatForkDialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabId: string;
  /** 分屏时被右键的 leaf；缺省用焦点 leaf。 */
  leafId?: string;
}

/** 标签页右键与终端右键共用的分叉入口：提交时才取最新的 tab，不捕获打开时的旧快照。 */
export default function TerminalForkDialog({ open, onOpenChange, tabId, leafId }: Props) {
  const tab = usePanesStore.getState().findTabAcrossLayouts(tabId)?.tab;
  const source = tab ? terminalForkSource(tab, leafId) : null;
  return (
    <ChatForkDialog
      open={open}
      onOpenChange={onOpenChange}
      allowWorktree={!source?.wsl}
      onFork={async (mode) => {
        const store = usePanesStore.getState();
        const location = store.findTabAcrossLayouts(tabId);
        if (!location) throw new Error("This terminal is no longer open");
        const { buildTerminalFork } = await import("@/services/chatForkLaunch");
        // 全部布局的标签标题（当前布局的活树由 eachLayoutTree 经 layoutTree 取到）
        const titles: string[] = [];
        eachLayoutTree(store, (_layout, tree) => titles.push(...collectTabs(tree).map((t) => t.title)));
        const options = await buildTerminalFork(location.tab, mode, leafId, titles);
        store.addTab(location.panel.id, options);
      }}
    />
  );
}
