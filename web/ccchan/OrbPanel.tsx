// 任务球展开的会话列表：置顶段 + 自动段；悬停行计时自动切换（行底进度条），
// 单击行立即切换，行尾图钉置顶 / 取消置顶。
import { useTranslation } from "react-i18next";
import { Pin } from "lucide-react";
import { SegmentedTabs } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { PET_STATUS_COLOR } from "./petStatus";
import {
  inputAge,
  ORB_FRESH_INPUT_MS,
  ORB_PANEL_METRICS,
  ORB_TIMINGS,
  type OrbEntry,
  type OrderedOrb,
} from "./orbModel";
import type { CCChanOrbSort } from "./types";

export interface OrbPanelProps {
  rect: { x: number; y: number; width: number; height: number };
  ordered: OrderedOrb;
  total: number;
  need: number;
  sort: CCChanOrbSort;
  hoverSwitch: boolean;
  highlight: number;
  dwellId: string | null;
  pinned: readonly string[];
  now: number;
  onRowEnter: (sessionId: string, index: number) => void;
  onRowLeave: () => void;
  onSelect: (sessionId: string) => void;
  onTogglePin: (sessionId: string) => void;
  onSort: (sort: CCChanOrbSort) => void;
  onHoverSwitch: (enabled: boolean) => void;
  onPointerEnter: () => void;
}

function StatusDot({ entry }: { entry: OrbEntry }) {
  // 色 + 形冗余：等你回复的点带一圈描边。
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      style={{
        background: PET_STATUS_COLOR[entry.status],
        boxShadow: entry.status === "needsInput" ? `0 0 0 3px var(--app-status-warning-bg)` : undefined,
      }}
    />
  );
}

interface RowProps {
  entry: OrbEntry;
  index: number;
  pinned: boolean;
  props: OrbPanelProps;
}

function OrbRow({ entry, index, pinned, props }: RowProps) {
  const { t } = useTranslation("ccchan");
  const age = inputAge(entry.lastInputAt, props.now);
  const fresh = entry.lastInputAt !== null && props.now - entry.lastInputAt < ORB_FRESH_INPUT_MS;
  const highlighted = props.highlight === index;
  return (
    <div
      data-orb-row={entry.sessionId}
      data-orb-index={index}
      data-current={highlighted ? "true" : undefined}
      className={cn("relative flex items-center rounded-lg", highlighted && "bg-[var(--accent)]")}
      style={{ height: ORB_PANEL_METRICS.row }}
      onPointerEnter={() => props.onRowEnter(entry.sessionId, index)}
      onPointerLeave={props.onRowLeave}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left"
        style={{ cursor: "default" }}
        onClick={() => props.onSelect(entry.sessionId)}
      >
        <span className="grid size-5 shrink-0 place-items-center rounded border border-[var(--border)] text-[11px] text-[var(--app-text-tertiary)]">
          {index < 9 ? index + 1 : "·"}
        </span>
        <StatusDot entry={entry} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] text-[var(--app-text-primary)]">{entry.title}</span>
          <span className="truncate text-[11px] text-[var(--app-text-tertiary)]">
            <span style={{ color: PET_STATUS_COLOR[entry.status] }}>{t(`status.${entry.status}`)}</span>
            {" · "}
            <span style={fresh ? { color: "var(--app-accent)" } : undefined}>
              {t(`orb.age.${age.key}`, "count" in age ? { count: age.count } : undefined)}
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={pinned ? t("orb.unpin") : t("orb.pin")}
        aria-pressed={pinned}
        data-orb-pin=""
        className={cn(
          "mr-1 grid size-8 shrink-0 place-items-center rounded-md text-[var(--app-text-tertiary)]",
          pinned ? "text-[var(--app-accent)]" : "opacity-40 hover:opacity-100",
        )}
        style={{ cursor: "default" }}
        onPointerEnter={props.onRowLeave}
        onClick={() => props.onTogglePin(entry.sessionId)}
      >
        <Pin size={14} fill={pinned ? "currentColor" : "none"} />
      </button>
      {props.dwellId === entry.sessionId && (
        <span
          data-testid="orb-dwell-bar"
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0.5 left-2.5 right-2.5 h-0.5 origin-left rounded-full"
          style={{
            background: "var(--app-accent)",
            animation: `ccchan-orb-dwell ${ORB_TIMINGS.dwellSwitchMs}ms linear forwards`,
          }}
        />
      )}
    </div>
  );
}

export function OrbPanel(props: OrbPanelProps) {
  const { t } = useTranslation("ccchan");
  const { ordered, rect } = props;
  const pinnedSet = new Set(props.pinned);
  const current = ordered.current;
  const sectionClass = "px-2.5 pb-1 pt-2 text-[11px] text-[var(--app-text-tertiary)]";
  return (
    <div
      data-pet-hit=""
      data-testid="orb-panel"
      role="dialog"
      aria-label={t("orb.title")}
      className="absolute flex flex-col overflow-hidden rounded-xl border shadow-lg"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        background: "var(--popover)",
        borderColor: "var(--border)",
        color: "var(--popover-foreground)",
      }}
      onPointerEnter={props.onPointerEnter}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--border)] px-3 py-2" style={{ height: ORB_PANEL_METRICS.header }}>
        <div className="flex items-center gap-2">
          <b className="text-[13px] font-semibold">{t("orb.title")}</b>
          <span className="truncate text-[11px] text-[var(--app-text-tertiary)]">
            {t("orb.summary", { count: props.total, need: props.need })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedTabs<CCChanOrbSort>
            size="sm"
            aria-label={t("orb.sort")}
            value={props.sort}
            onValueChange={props.onSort}
            items={[
              { value: "recent", label: t("orb.sortRecent") },
              { value: "attention", label: t("orb.sortAttention") },
            ]}
          />
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[var(--app-text-secondary)]">
            <Switch checked={props.hoverSwitch} onCheckedChange={props.onHoverSwitch} aria-label={t("orb.hoverSwitch")} />
            {t("orb.hoverSwitch")}
          </label>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" onPointerLeave={props.onRowLeave}>
        <div
          className="flex items-center gap-1.5 px-2.5 text-[11px] text-[var(--app-text-tertiary)]"
          style={{ height: ORB_PANEL_METRICS.current }}
        >
          <span>{t("orb.current")}</span>
          {current ? <StatusDot entry={current} /> : null}
          <span className="truncate text-[var(--app-text-secondary)]">{current ? current.title : t("orb.noCurrent")}</span>
        </div>
        {ordered.pinned.length > 0 && <div className={sectionClass}>{t("orb.sectionPinned")}</div>}
        {ordered.pinned.map((entry, index) => (
          <OrbRow key={entry.sessionId} entry={entry} index={index} pinned props={props} />
        ))}
        <div className={sectionClass}>{t(props.sort === "attention" ? "orb.sectionAttention" : "orb.sectionRecent")}</div>
        {ordered.auto.length === 0 && ordered.pinned.length === 0 ? (
          <div className="px-2.5 py-3 text-[12px] text-[var(--app-text-tertiary)]">{t("orb.empty")}</div>
        ) : null}
        {ordered.auto.map((entry, index) => {
          const position = ordered.pinned.length + index;
          return <OrbRow key={entry.sessionId} entry={entry} index={position} pinned={pinnedSet.has(entry.sessionId)} props={props} />;
        })}
      </div>
    </div>
  );
}
