// 灵动岛窗口根组件（index.html?mode=island）。
//
// 只消费两路输入：主窗口事件桥推来的会话快照、后端推来的设置 / 环境（全屏、主窗口前台）。
// 每次可见形态变化都把内容外框上报给后端，原生窗口随之改成同样大小——
// 窗口之外的屏幕区域因此天然可点击穿透。
import "@/i18n/islandResources";
import "./island.css";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { islandService } from "@/services/islandService";
import type { IslandSession } from "@/types/island";
import IslandApprovalCard from "./IslandApprovalCard";
import IslandPanel from "./IslandPanel";
import IslandPill, { IslandLine } from "./IslandPill";
import { deriveCollapsedView, groupSessions } from "./islandView";
import { useDonePop } from "./useDonePop";
import { useHoverExpand } from "./useHoverExpand";
import { useIslandData, useNow } from "./useIslandData";

/** 内容尺寸变化 → 上报后端改原生窗口外框（ResizeObserver，事件驱动）。 */
function useReportLayout(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    let last = "";
    const report = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      const key = `${width}x${height}`;
      if (width === 0 || height === 0 || key === last) return;
      last = key;
      void islandService.setLayout(width, height).catch(() => {});
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    report();
    return () => observer.disconnect();
  }, [ref]);
}

export default function IslandApp() {
  const { snapshot, settings, env } = useIslandData();
  const { hovered, onPointerEnter, onPointerLeave } = useHoverExpand();
  const [cardId, setCardId] = useState<string | null>(null);
  const now = useNow(snapshot.sessions.length > 0);
  const groups = useMemo(() => groupSessions(snapshot.sessions, now), [snapshot.sessions, now]);
  const pop = useDonePop(groups.done, settings.popOnFinish);
  const collapsed = deriveCollapsedView(groups, pop);
  const cardSession = cardId ? groups.needs.find((session) => session.id === cardId) ?? null : null;
  const rootRef = useRef<HTMLDivElement | null>(null);
  useReportLayout(rootRef);

  // 收起时审批卡一并关掉，下次悬停从总览开始。
  useEffect(() => {
    if (!hovered) setCardId(null);
  }, [hovered]);

  const activate = useCallback((session: IslandSession) => {
    void islandService.activateSession({ kind: session.kind, id: session.id }).catch(() => {});
  }, []);
  const respond = useCallback((session: IslandSession, optionId: string) => {
    if (!session.approval) return;
    void islandService.respondPermission({
      chatId: session.id,
      requestKey: session.approval.requestKey,
      optionId,
    }).catch(() => {});
  }, []);
  const closeCard = useCallback(() => setCardId(null), []);
  const openCard = useCallback((session: IslandSession) => setCardId(session.id), []);

  const edge = settings.position;
  const line = env.fullscreen && settings.collapseInFullscreen && !hovered;

  let content;
  if (line) {
    content = <IslandLine edge={edge} needs={groups.needs.length > 0} />;
  } else if (hovered && cardSession) {
    content = (
      <IslandApprovalCard
        session={cardSession}
        edge={edge}
        keysActive={hovered}
        onRespond={respond}
        onJump={activate}
        onBack={closeCard}
      />
    );
  } else if (hovered) {
    content = (
      <IslandPanel
        groups={groups}
        quota={snapshot.quota}
        showQuota={settings.showQuota}
        edge={edge}
        now={now}
        onOpen={activate}
        onOpenApproval={openCard}
        onApprove={respond}
      />
    );
  } else {
    content = <IslandPill view={collapsed} edge={edge} now={now} />;
  }

  return (
    <div
      ref={rootRef}
      className="island-root"
      data-edge={edge}
      data-testid="island-root"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {content}
    </div>
  );
}
