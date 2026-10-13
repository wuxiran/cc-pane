import type { TFunction } from "i18next";
import { useTabAttentionStore } from "@/stores/useTabAttentionStore";
import { useTabResourceBadgeStore } from "@/stores/useTabResourceBadgeStore";
import { useResourcePopoverStore } from "@/stores/useResourcePopoverStore";
import { formatSize } from "@/utils";

interface TabBadgeDotsProps {
  tabId: string;
  t: TFunction<"panes">;
}

/**
 * 标签右侧的两个小点，各自只订阅自己的条目，避免任何标记变化全列表重渲：
 * - 红点：后台注意（完成 / 出错 / 等输入），切过去即灭（docs/78）；
 * - 琥珀点：正在吃资源（docs/107 W4），**不随可见清除**，条件消失才灭；
 *   点一下打开资源管理器并定位到该会话。
 */
export default function TabBadgeDots({ tabId, t }: TabBadgeDotsProps) {
  const hasAttentionMark = useTabAttentionStore((st) => Boolean(st.entries[tabId]));
  const resource = useTabResourceBadgeStore((st) => st.entries[tabId]);
  const openForSession = useResourcePopoverStore((st) => st.openForSession);

  return (
    <>
      {hasAttentionMark && (
        <span
          aria-label={t("tabAttentionDot")}
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: "var(--app-status-danger)" }}
        />
      )}
      {resource && (
        <button
          type="button"
          aria-label={t("tabResourceDot")}
          title={resourceTitle(resource.cpuPercent, resource.memoryBytes, t)}
          className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full hover:bg-[var(--app-hover)]"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (resource.sessionId) openForSession(resource.sessionId);
            else useResourcePopoverStore.getState().setOpen(true);
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--app-status-warning)" }}
          />
        </button>
      )}
    </>
  );
}

function resourceTitle(
  cpuPercent: number | undefined,
  memoryBytes: number | undefined,
  t: TFunction<"panes">,
): string {
  const parts: string[] = [];
  if (cpuPercent !== undefined) parts.push(`CPU ${Math.round(cpuPercent)}%`);
  if (memoryBytes !== undefined) parts.push(formatSize(memoryBytes));
  return parts.length > 0 ? `${t("tabResourceDot")} · ${parts.join(" · ")}` : t("tabResourceDot");
}
