import { useTranslation } from "react-i18next";
import type { IslandPosition, IslandQuota, IslandSession } from "@/types/island";
import type { RateLimitWindow } from "@/types/rateLimit";
import {
  formatDuration,
  formatPercent,
  formatWindowLength,
  rateLimitSeverity,
} from "@/utils/rateLimitDisplay";
import { IslandCheck, IslandFace, IslandNeedsDot, IslandSpinner } from "./IslandIcons";
import { formatElapsed, minutesAgo, quickApproveOption, type IslandGroups } from "./islandView";

interface IslandPanelProps {
  groups: IslandGroups;
  quota: IslandQuota | null;
  showQuota: boolean;
  edge: IslandPosition;
  now: number;
  onOpen: (session: IslandSession) => void;
  onOpenApproval: (session: IslandSession) => void;
  onApprove: (session: IslandSession, optionId: string) => void;
}

function RowTitle({ session }: { session: IslandSession }) {
  return (
    <span className="island-ellipsis">
      {session.name}
      {session.cli ? <span className="island-tag">{session.cli}</span> : null}
    </span>
  );
}

function NeedsRow({ session, onOpen, onOpenApproval, onApprove }: {
  session: IslandSession;
  onOpen: (session: IslandSession) => void;
  onOpenApproval: (session: IslandSession) => void;
  onApprove: (session: IslandSession, optionId: string) => void;
}) {
  const { t } = useTranslation("island");
  const approve = session.approval ? quickApproveOption(session.approval.options) : null;
  const detail = session.approval?.title ?? session.activity ?? t("waitingInput");
  return (
    <div className="island-row" data-tone="needs" role="group">
      <IslandNeedsDot />
      <button type="button" className="island-row-main island-link" style={{ color: "inherit" }} onClick={() => onOpenApproval(session)}>
        <RowTitle session={session} />
        <span className="island-row-detail island-ellipsis">{detail}</span>
      </button>
      {approve ? (
        <button
          type="button"
          className="island-btn"
          data-tone="primary"
          disabled={session.approval?.responding}
          onClick={() => onApprove(session, approve.optionId)}
        >
          {t("approve")}
        </button>
      ) : null}
      <button type="button" className="island-btn" onClick={() => onOpen(session)}>{t("view")}</button>
    </div>
  );
}

function SessionRow({ session, now, onOpen }: { session: IslandSession; now: number; onOpen: (session: IslandSession) => void }) {
  const { t } = useTranslation("island");
  const running = session.state === "running";
  const ago = minutesAgo(session.since, now);
  return (
    <button type="button" className="island-row" data-tone={session.state} onClick={() => onOpen(session)}>
      {running ? <IslandSpinner /> : <IslandCheck />}
      <span className="island-row-main">
        <RowTitle session={session} />
        {session.activity ? <span className="island-row-detail island-ellipsis">{session.activity}</span> : null}
      </span>
      {running
        ? <span className="island-muted island-mono">{formatElapsed(now - session.since)}</span>
        : <span className="island-muted">{ago < 1 ? t("justNow") : t("minutesAgo", { count: ago })}</span>}
    </button>
  );
}

function QuotaBars({ quota, now }: { quota: IslandQuota; now: number }) {
  const { t } = useTranslation("island");
  const label = (window: RateLimitWindow) => {
    if (window.windowMinutes === 300) return t("quotaFiveHour", { provider: quota.provider });
    if (window.windowMinutes === 10080) return t("quotaWeekly", { provider: quota.provider });
    return t("quotaWindow", { provider: quota.provider, length: formatWindowLength(window.windowMinutes) ?? window.slot });
  };
  return (
    <div className="island-quota">
      {quota.windows.slice(0, 2).map((window) => (
        <div key={window.slot} className="island-quota-item">
          <div className="island-quota-top">
            <span>{label(window)}</span>
            <span className="island-mono">
              {formatPercent(window.usedPercent)}
              {window.resetsAt ? <span className="island-muted"> ↻{formatDuration(window.resetsAt - now)}</span> : null}
            </span>
          </div>
          <div className="island-bar" data-severity={rateLimitSeverity(window.usedPercent)}>
            <i style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 悬停展开：按「需要你 → 运行中 → 刚完成」分组，点一行跳到那个窗格，底部常驻额度。 */
export default function IslandPanel({ groups, quota, showQuota, edge, now, onOpen, onOpenApproval, onApprove }: IslandPanelProps) {
  const { t } = useTranslation("island");
  const total = groups.needs.length + groups.running.length + groups.done.length;
  return (
    <div className="island-panel" data-edge={edge}>
      <div className="island-head">
        <IslandFace />
        <b>{t("brand")}</b>
        <span className="island-muted">{t("sessionCount", { count: total })}</span>
        <span className="island-spacer" />
      </div>
      <div className="island-scroll">
        {total === 0 ? <div className="island-empty">{t("empty")}</div> : null}
        {groups.needs.length > 0 ? <div className="island-section">{t("sectionNeeds", { count: groups.needs.length })}</div> : null}
        {groups.needs.map((session) => (
          <NeedsRow key={session.id} session={session} onOpen={onOpen} onOpenApproval={onOpenApproval} onApprove={onApprove} />
        ))}
        {groups.running.length > 0 ? <div className="island-section">{t("sectionRunning", { count: groups.running.length })}</div> : null}
        {groups.running.map((session) => <SessionRow key={session.id} session={session} now={now} onOpen={onOpen} />)}
        {groups.done.length > 0 ? <div className="island-section">{t("sectionDone", { count: groups.done.length })}</div> : null}
        {groups.done.map((session) => <SessionRow key={session.id} session={session} now={now} onOpen={onOpen} />)}
      </div>
      {showQuota && quota ? <QuotaBars quota={quota} now={now} /> : null}
    </div>
  );
}
