import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { TAB_GROUP_ICON, TAB_GROUP_LABEL_KEY } from "@/lib/tabContentType";
import type { TabContentGroup } from "@/lib/tabContentType";
import { nonEmptyGroups } from "./layoutTypeSummary";
import type { LayoutTypeSummary } from "./layoutTypeSummary";

// 布局卡片的内容类型计数桁：终端 / 浏览器 / 文件 / 工具，每桁「图标 + 数字」。
//
// 单击 = 跳到该类的下一个 tab（首次跳第一个，再点轮换，只有一个则原地不动）。
// 刻意**不做过滤**：过滤态会让其余 tab 从 TabBar 消失，用户第一反应是「我的终端
// 呢」，还得再学一个退出手势；轮换没有需要退出的状态。
//
// 游标只存在组件内 ref——纯瞬时交互状态，进 store 只会多一份要持久化/迁移的负担。
export default function LayoutTypeCounts({
  summary,
  selected,
  onJump,
}: {
  summary: LayoutTypeSummary;
  selected: boolean;
  /** 跳转到指定 tab；调用方负责先切到本布局 */
  onJump: (paneId: string, tabId: string) => void;
}) {
  const { t } = useTranslation("panes");
  // key = group，value = 下一次要跳的下标
  const cursors = useRef<Partial<Record<TabContentGroup, number>>>({});
  const groups = nonEmptyGroups(summary);
  if (groups.length === 0) return null;

  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="layout-type-counts">
      {groups.map(({ group, tabs }) => {
        const Icon = TAB_GROUP_ICON[group];
        const name = t(TAB_GROUP_LABEL_KEY[group]);
        return (
          <button
            key={group}
            type="button"
            title={name}
            aria-label={`${tabs.length} ${name}`}
            data-type-group={group}
            className="flex shrink-0 items-center gap-1 rounded-sm px-0.5 hover:bg-[var(--app-hover)]"
            style={{ color: selected ? "inherit" : "var(--app-text-tertiary)" }}
            onClick={(event) => {
              // 卡片本身是 role="tab" 的按钮，不拦住就会连带触发切布局+可能的拖拽
              event.preventDefault();
              event.stopPropagation();
              const index = (cursors.current[group] ?? 0) % tabs.length;
              cursors.current[group] = index + 1;
              const target = tabs[index];
              onJump(target.paneId, target.tabId);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className="text-[11px] leading-none tabular-nums">{tabs.length}</span>
          </button>
        );
      })}
    </span>
  );
}
