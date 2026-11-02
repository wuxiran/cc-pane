// 标签左侧的图标位。
//
// 终端保留状态点（它有会话状态要表达），其余六类一律出类型图标——此前只有
// browser 有图标（Globe2），editor/file-explorer/mcp/skill/memory 全是裸标题，
// 混在一排里分不清哪个是哪个。图标表见 lib/tabContentType.ts。
import StatusIndicator from "@/components/StatusIndicator";
import { useState } from "react";
import { safeBrowserFavicon } from "@/lib/browserTabPresentation";
import { TAB_CONTENT_ICON } from "@/lib/tabContentType";
import { useTerminalStatusStore } from "@/stores/useTerminalStatusStore";
import type { Tab, TerminalStatusType } from "@/types";

export default function TabTypeIcon({
  tab,
  statusSize,
  iconSize,
  getStatus,
}: {
  tab: Tab;
  statusSize: number;
  iconSize: number;
  getStatus: (sessionId: string | null) => TerminalStatusType | null;
}) {
  // OSC 9;4 进度徽章（F5）：有值时状态点外圈叠加进度环。直接读 store 选择器，
  // 避免 TabBar → SortableTab → 这里三层 prop 钻透（TabBar 受行数棘轮约束）。
  const getOscProgress = useTerminalStatusStore((s) => s.getOscProgress);
  const [failedIcon, setFailedIcon] = useState<string>();
  const favicon = tab.contentType === "browser" ? safeBrowserFavicon(tab.browserFaviconUrl, tab.browserUrl) : undefined;
  const TypeIcon = tab.contentType === "terminal" ? null : TAB_CONTENT_ICON[tab.contentType];
  if (favicon && favicon !== failedIcon) {
    return <img src={favicon} alt="" referrerPolicy="no-referrer" width={iconSize} height={iconSize}
      className="shrink-0 rounded-sm object-contain" onError={() => setFailedIcon(favicon)} />;
  }
  if (!TypeIcon) {
    return (
      <StatusIndicator
        status={getStatus(tab.sessionId ?? null)}
        oscProgress={getOscProgress(tab.sessionId ?? null)}
        size={statusSize}
      />
    );
  }
  return (
    <TypeIcon
      size={iconSize}
      className="shrink-0 text-[var(--app-text-tertiary)]"
      aria-hidden="true"
    />
  );
}
